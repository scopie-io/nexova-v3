/**
 * Real Claude gateway built on the official Anthropic SDK.
 *
 *  - research():               agentic web research with the server-side web_search / web_fetch
 *                              tools (manual loop, handles pause_turn), streamed.
 *  - extractFromAttachments(): vision over merchant screenshots / captured pages -> structured extracts
 *  - normalizeStore():         structured output -> StoreDraft
 *  - normalizeProducts():      structured output -> ProductBatchDraft (called per batch)
 *  - enrich():                 structured output (+ vision on local images) -> EnrichmentDraft
 *
 * Every call records token usage + cost in the UsageLedger. Server-side refusal fallbacks
 * are enabled by default (config.fallbacks) so a policy decline re-runs on a fallback model
 * inside the same request.
 */
import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import type { z } from "zod";
import type { EngineConfig } from "../config.js";
import { AttachmentBatchDraftSchema, EnrichmentDraftSchema, ProductBatchDraftSchema, StoreDraftSchema, type EnrichmentDraft, type ProductDraft, type StoreDraft } from "../schema/drafts.js";
import type { Attachment, AttachmentExtract, ResearchCitation, ResearchFindings } from "../schema/signals.js";
import { count, text } from "./mapping.js";
import { prepareForVision } from "../ingest/images.js";
import { summarizeForResearch, summarizeSignalsForPrompt } from "../ingest/ingest.js";
import { createLogger, errorMessage } from "../util/log.js";
import { withRetry } from "../util/retry.js";
import { clampText } from "../util/text.js";
import type { AttachmentVisionInput, ClaudeGateway, EnrichInput, GatewayContext, GatewayPing, NormalizeProductsInput, NormalizeStoreInput, ResearchInput, SchemaCheck } from "./gateway.js";
import { NexovaError } from "./gateway.js";
import { ATTACHMENT_SYSTEM, ENRICH_SYSTEM, NORMALIZE_PRODUCTS_SYSTEM, NORMALIZE_STORE_SYSTEM, RESEARCH_SYSTEM } from "./prompts.js";
import type { UsageLedger } from "./usage.js";

const log = createLogger("claude");

type BetaMessage = Anthropic.Beta.BetaMessage;
type BetaMessageParam = Anthropic.Beta.BetaMessageParam;
const VISION_BATCH = 6;
/** Images (tiles) per vision request; tall screenshots expand into several tiles. */
const MAX_TILES_PER_CALL = 10;

export class AnthropicGateway implements ClaudeGateway {
  readonly id = "anthropic";
  private readonly client: Anthropic;

  constructor(
    private readonly config: EngineConfig,
    private readonly ledger: UsageLedger,
    client?: Anthropic,
  ) {
    this.client = client ?? new Anthropic({ maxRetries: 3, timeout: 10 * 60 * 1000 });
  }

  // ---------- shared request plumbing ----------

  private betas(): string[] | undefined {
    if (this.config.fallbacks === "default") return ["server-side-fallback-2026-07-01"];
    if (this.config.fallbacks) return ["server-side-fallback-2026-06-01"];
    return undefined;
  }

  private fallbacks(): Anthropic.Beta.BetaFallbacksParam | undefined {
    if (this.config.fallbacks === "default") return "default";
    if (this.config.fallbacks) return [{ model: this.config.fallbacks.model }];
    return undefined;
  }

  private system(text: string): Anthropic.Beta.BetaTextBlockParam[] {
    return [{ type: "text", text, cache_control: { type: "ephemeral" } }];
  }

  private async recordUsage(step: string, ctx: GatewayContext, msg: BetaMessage, startedAt: number): Promise<void> {
    const servedBy = msg.model && msg.model !== this.config.model ? msg.model : null;
    await this.ledger.record({ jobId: ctx.jobId, step, model: this.config.model, servedBy, usage: msg.usage, durationMs: Date.now() - startedAt, stopReason: msg.stop_reason });
  }

  private assertNotRefused(msg: BetaMessage, step: string): void {
    if (msg.stop_reason === "refusal") {
      const details = msg.stop_details && "category" in msg.stop_details ? `${msg.stop_details.category ?? "unknown"}: ${msg.stop_details.explanation ?? ""}` : "no details";
      throw new NexovaError(`Claude declined the ${step} request (${details})`, "refusal", false);
    }
  }

  private isRetryable(err: unknown): boolean {
    if (err instanceof Anthropic.RateLimitError) return true;
    if (err instanceof Anthropic.InternalServerError) return true;
    if (err instanceof Anthropic.APIConnectionError) return true;
    if (err instanceof Anthropic.APIError) return (err.status ?? 0) >= 500 || err.status === 408 || err.status === 409;
    if (err instanceof NexovaError) return err.retryable;
    return false;
  }

  /** Structured output call with streaming (no HTTP timeouts on long JSON) and one schema-repair retry. */
  private async structured<S extends z.ZodType>(params: { step: string; ctx: GatewayContext; system: string; user: Anthropic.Beta.BetaContentBlockParam[] | string; schema: S; maxTokens: number }): Promise<z.infer<S>> {
    return withRetry(
      async (attempt) => {
        const startedAt = Date.now();
        const stream = this.client.beta.messages.stream(
          {
            model: this.config.model,
            max_tokens: params.maxTokens,
            betas: this.betas(),
            fallbacks: this.fallbacks(),
            system: this.system(params.system),
            thinking: { type: "adaptive" },
            output_config: { effort: this.config.effort, format: betaZodOutputFormat(params.schema) },
            messages: [{ role: "user", content: params.user }],
          },
          { signal: params.ctx.signal },
        );
        let msg: BetaMessage;
        try {
          msg = await stream.finalMessage();
        } catch (err) {
          // The SDK parses structured output itself, so a response cut off at max_tokens surfaces
          // here as a JSON syntax error before stop_reason can be inspected. Name it for callers,
          // which respond by splitting the work rather than retrying the same oversized request.
          if (isTruncatedOutput(err)) throw new NexovaError(`${params.step}: output exceeded ${params.maxTokens} tokens and was cut off`, "truncated", false);
          throw err;
        }
        await this.recordUsage(params.step, params.ctx, msg, startedAt);
        this.assertNotRefused(msg, params.step);
        if (msg.stop_reason === "max_tokens") throw new NexovaError(`${params.step}: output exceeded ${params.maxTokens} tokens and was cut off`, "truncated", false);
        const parsed = (msg as { parsed_output?: z.infer<S> | null }).parsed_output;
        if (parsed == null) {
          // Fall back to manual parse of the text block (structured outputs guarantee valid JSON).
          const text = msg.content.filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text").map((b) => b.text).join("");
          const result = params.schema.safeParse(JSON.parse(text));
          if (!result.success) throw new NexovaError(`${params.step}: schema validation failed: ${result.error.message.slice(0, 500)}`, "schema", attempt === 0);
          return result.data as z.infer<S>;
        }
        return parsed;
      },
      { retries: 2, baseMs: 1500, shouldRetry: (err) => this.isRetryable(err), onRetry: (err, n, delay) => log.warn(`${params.step} retry ${n} in ${delay}ms: ${errorMessage(err)}`) },
    );
  }

  /** One vision-ready block per prepared tile (tall screenshots become several). */
  private async imageBlocks(p: string, maxTiles = 6): Promise<{ blocks: Anthropic.Beta.BetaImageBlockParam[]; note: string }> {
    const prepared = await prepareForVision(p, { maxTiles });
    return {
      blocks: prepared.tiles.map((t) => ({ type: "image", source: { type: "base64", media_type: t.media, data: t.base64 } })),
      note: prepared.note,
    };
  }

  // ---------- health ----------

  async ping(ctx: GatewayContext): Promise<GatewayPing> {
    const startedAt = Date.now();
    const msg = await this.client.beta.messages.create(
      {
        model: this.config.model,
        max_tokens: 64,
        betas: this.betas(),
        fallbacks: this.fallbacks(),
        messages: [{ role: "user", content: "Reply with exactly: NEXOVA OK" }],
      },
      { signal: ctx.signal },
    );
    const entry = await this.ledger.record({ jobId: ctx.jobId, step: "doctor", model: this.config.model, servedBy: msg.model !== this.config.model ? msg.model : null, usage: msg.usage, durationMs: Date.now() - startedAt, stopReason: msg.stop_reason });
    return {
      servedBy: msg.model,
      text: msg.content.filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text").map((b) => b.text).join(""),
      inputTokens: msg.usage.input_tokens,
      outputTokens: msg.usage.output_tokens,
      costUsd: entry.costUsd,
      durationMs: Date.now() - startedAt,
    };
  }

  async validateSchemas(ctx: GatewayContext): Promise<SchemaCheck[]> {
    const schemas: Array<[string, z.ZodType]> = [
      ["StoreDraft (normalize)", StoreDraftSchema],
      ["ProductBatchDraft (normalize)", ProductBatchDraftSchema],
      ["AttachmentBatchDraft (vision)", AttachmentBatchDraftSchema],
      ["EnrichmentDraft (enrich)", EnrichmentDraftSchema],
    ];
    const out: SchemaCheck[] = [];
    for (const [name, schema] of schemas) {
      const startedAt = Date.now();
      try {
        const msg = await this.client.beta.messages.create(
          {
            model: this.config.model,
            max_tokens: 900,
            betas: this.betas(),
            fallbacks: this.fallbacks(),
            output_config: { effort: "low", format: betaZodOutputFormat(schema) },
            messages: [{ role: "user", content: "Return a minimal placeholder object. This is a schema compilation check, not real data." }],
          },
          { signal: ctx.signal },
        );
        await this.recordUsage("doctor", ctx, msg, startedAt);
        out.push({ name, ok: true, error: null, ms: Date.now() - startedAt });
      } catch (err) {
        const message = err instanceof Anthropic.APIError ? `${err.status}: ${(err.message ?? "").slice(0, 220)}` : errorMessage(err).slice(0, 220);
        out.push({ name, ok: false, error: message, ms: Date.now() - startedAt });
      }
    }
    return out;
  }

  // ---------- vision over attachments ----------

  async extractFromAttachments(input: AttachmentVisionInput, ctx: GatewayContext): Promise<AttachmentExtract[]> {
    const out: AttachmentExtract[] = [];
    const images = input.images.slice(0, this.config.maxVisionImages);

    // Prepare first: a tall capture becomes several tiles, so batches are sized by tiles, not files.
    const prepared: Array<{ a: Attachment; blocks: Anthropic.Beta.BetaImageBlockParam[]; note: string }> = [];
    for (const a of images) {
      const { blocks, note } = await this.imageBlocks(a.path);
      if (!blocks.length) out.push(emptyExtract(a, note || "image could not be prepared for reading"));
      else prepared.push({ a, blocks, note });
    }

    let cursor = 0;
    while (cursor < prepared.length) {
      const batch: typeof prepared = [];
      let tiles = 0;
      while (cursor < prepared.length && batch.length < VISION_BATCH && (tiles === 0 || tiles + prepared[cursor].blocks.length <= MAX_TILES_PER_CALL)) {
        tiles += prepared[cursor].blocks.length;
        batch.push(prepared[cursor]);
        cursor++;
      }
      ctx.onProgress?.(`Reading screenshot${batch.length === 1 ? "" : "s"} ${cursor - batch.length + 1}–${cursor} of ${prepared.length}…`);
      const content: Anthropic.Beta.BetaContentBlockParam[] = [];
      batch.forEach(({ a, blocks }, i) => {
        blocks.forEach((block, part) => {
          const label = blocks.length > 1 ? `Screenshot ${i} (${a.name}) — part ${part + 1} of ${blocks.length}, scrolling down` : `Screenshot ${i}: ${a.name}`;
          content.push({ type: "text", text: `${label}${a.origin === "capture" ? " [captured from the live page by our browser]" : " [uploaded by the merchant]"}` });
          content.push(block);
        });
      });
      content.push({
        type: "text",
        text: [
          `Return exactly ${batch.length} item(s): one per screenshot, imageIndex 0..${batch.length - 1}.`,
          batch.some((b) => b.blocks.length > 1) ? "Screenshots shown in several parts are one continuous page: merge their products into that screenshot's single item and do not report the same product twice." : "",
          input.context ? `Context: ${input.context}` : "",
        ]
          .filter(Boolean)
          .join("\n"),
      });
      const included = batch.map((b) => b.a);
      const draft = await this.structured({ step: "vision", ctx, system: ATTACHMENT_SYSTEM, user: content, schema: AttachmentBatchDraftSchema, maxTokens: 24_000 });
      const byIndex = new Map(draft.items.map((it) => [it.imageIndex, it]));
      included.forEach((a, i) => {
        const it = byIndex.get(i) ?? draft.items[i];
        if (!it) {
          out.push(emptyExtract(a, "no extraction returned"));
          return;
        }
        out.push({
          attachmentId: a.id,
          name: a.name,
          kind: a.kind,
          platformGuess: it.platform,
          pageType: it.pageType,
          shopName: text(it.shopName),
          handle: text(it.handle)?.replace(/^@/, "") ?? null,
          bio: text(it.bio),
          followers: count(it.followers),
          rating: count(it.rating),
          location: text(it.location),
          contacts: { whatsapp: text(it.whatsapp)?.replace(/[^\d]/g, "") || null, email: text(it.email), phone: text(it.phone), website: text(it.website) },
          socialHandles: it.socialHandles.map((h) => ({ platform: h.platform, handle: h.handle.replace(/^@/, "") })),
          products: it.products
            .filter((p) => p.readable && p.title.trim())
            .map((p) => ({
              title: p.title.trim(),
              description: text(p.description),
              priceText: text(p.priceText),
              price: count(p.price),
              currency: text(p.currency),
              compareAtPrice: count(p.compareAtPrice),
              soldCount: count(p.soldCount),
              rating: count(p.rating),
              variants: p.variants.length ? p.variants.map((v) => ({ title: v })) : undefined,
              images: [],
              via: "vision",
              evidence: `attachment:${a.id}`,
              sourcePlatform: it.platform,
              notes: p.stockText ? [`stock: ${p.stockText}`] : [],
            })),
          visibleText: it.visibleText,
          notes: it.notes,
          confidence: it.confidence,
          via: "vision",
        });
      });
    }
    return out;
  }

  // ---------- research ----------

  async research(input: ResearchInput, ctx: GatewayContext): Promise<ResearchFindings> {
    const user = [
      "Research this merchant and write the brief. Focus your browsing on the gaps listed at the end.",
      input.instructions ? `Merchant instructions: ${input.instructions}` : "",
      "",
      clampText(summarizeForResearch(input.ingest), 20_000),
    ]
      .filter(Boolean)
      .join("\n");

    const tools = [
      { type: "web_search_20260209" as const, name: "web_search" as const, max_uses: 8 },
      { type: "web_fetch_20260209" as const, name: "web_fetch" as const, max_uses: 10, max_content_tokens: 12_000 },
    ];
    const messages: BetaMessageParam[] = [{ role: "user", content: user }];
    const citations = new Map<string, ResearchCitation>();
    let searches = 0;
    let fetches = 0;
    let final: BetaMessage | null = null;
    let textSoFar = "";

    for (let continuation = 0; continuation < 8; continuation++) {
      const startedAt = Date.now();
      const stream = this.client.beta.messages.stream(
        {
          model: this.config.model,
          max_tokens: 32_000,
          betas: this.betas(),
          fallbacks: this.fallbacks(),
          system: this.system(RESEARCH_SYSTEM),
          thinking: { type: "adaptive" },
          // Browsing rewards breadth over deliberation, and every round re-sends the transcript,
          // so research runs a notch below the effort used for the reasoning-heavy steps.
          output_config: { effort: this.config.researchEffort },
          tools,
          messages,
        },
        { signal: ctx.signal },
      );
      let lastProgress = 0;
      stream.on("text", (delta) => {
        textSoFar += delta;
        if (Date.now() - lastProgress > 2500) {
          lastProgress = Date.now();
          ctx.onProgress?.(`Writing research brief… ${Math.round(textSoFar.length / 4)} tokens`);
        }
      });
      const msg = await withRetry(() => stream.finalMessage(), { retries: 1, shouldRetry: (e) => this.isRetryable(e) });
      await this.recordUsage("research", ctx, msg, startedAt);
      searches += msg.usage.server_tool_use?.web_search_requests ?? 0;
      fetches += msg.usage.server_tool_use?.web_fetch_requests ?? 0;
      for (const block of msg.content) {
        if (block.type === "web_search_tool_result" && Array.isArray(block.content)) {
          for (const r of block.content) if (r.type === "web_search_result") citations.set(r.url, { url: r.url, title: r.title });
        } else if (block.type === "web_fetch_tool_result" && block.content.type === "web_fetch_result") {
          citations.set(block.content.url, { url: block.content.url, title: block.content.content.title ?? block.content.url });
        } else if (block.type === "server_tool_use") {
          const q = (block.input as { query?: string; url?: string }) ?? {};
          ctx.onProgress?.(block.name === "web_search" ? `Searching: ${q.query ?? ""}` : `Reading: ${q.url ?? ""}`);
        }
      }
      if (msg.stop_reason === "pause_turn") {
        messages.push({ role: "assistant", content: msg.content });
        continue;
      }
      final = msg;
      break;
    }
    if (!final) return { markdown: textSoFar, citations: [...citations.values()], searches, fetches, skipped: false };
    if (final.stop_reason === "refusal") {
      log.warn("research refused; continuing without a brief");
      return { markdown: "", citations: [], searches, fetches, skipped: true };
    }
    const markdown = final.content.filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text").map((b) => b.text).join("\n").trim();
    return { markdown, citations: [...citations.values()], searches, fetches, skipped: false };
  }

  // ---------- normalize ----------

  async normalizeStore(input: NormalizeStoreInput, ctx: GatewayContext): Promise<StoreDraft> {
    ctx.onProgress?.("Normalizing brand, theme and store settings…");
    const signals = summarizeSignalsForPrompt(input.ingest, 40);
    const user = [
      "Build the store definition from the material below.",
      input.instructions ? `Merchant instructions: ${input.instructions}` : "",
      input.currencyHint ? `Currency hint from the merchant's marketplace/region: ${input.currencyHint}` : "",
      input.localeHint ? `Locale hint: ${input.localeHint}` : "",
      "",
      "## Research brief",
      input.research.skipped ? "(no research available)" : clampText(input.research.markdown, 30_000),
      "",
      "## Gathered material",
      clampText(signals, 80_000),
    ]
      .filter((l) => l !== "")
      .join("\n");
    return this.structured({ step: "normalize-store", ctx, system: NORMALIZE_STORE_SYSTEM, user, schema: StoreDraftSchema, maxTokens: 16_000 });
  }

  /**
   * A batch whose JSON would exceed the output budget is split and retried rather than failed:
   * how long the descriptions run is not knowable in advance, and losing a whole catalog to one
   * oversized batch is the wrong outcome.
   */
  async normalizeProducts(input: NormalizeProductsInput, ctx: GatewayContext): Promise<ProductDraft[]> {
    try {
      return await this.normalizeProductBatch(input, ctx);
    } catch (err) {
      const truncated = err instanceof NexovaError && err.code === "truncated";
      if (!truncated || input.rawProducts.length < 4) throw err;
      const mid = Math.ceil(input.rawProducts.length / 2);
      log.warn(`products batch of ${input.rawProducts.length} was too large; splitting into ${mid} + ${input.rawProducts.length - mid}`);
      ctx.onProgress?.(`Batch too large, splitting into two smaller batches…`);
      const first = await this.normalizeProducts({ ...input, rawProducts: input.rawProducts.slice(0, mid) }, ctx);
      const second = await this.normalizeProducts({ ...input, rawProducts: input.rawProducts.slice(mid), maxProducts: Math.max(1, input.maxProducts - first.length) }, ctx);
      return [...first, ...second];
    }
  }

  private async normalizeProductBatch(input: NormalizeProductsInput, ctx: GatewayContext): Promise<ProductDraft[]> {
    ctx.onProgress?.(`Normalizing ${input.rawProducts.length} products (batch ${input.batchIndex + 1}/${input.batchCount})…`);
    const raw = input.rawProducts
      .map((p, i) => {
        const bits = [
          `${i + 1}. ${p.title}`,
          p.price != null ? `price: ${p.currency ?? ""} ${p.price}` : p.priceText ? `price text: ${p.priceText}` : "price: unknown",
          p.compareAtPrice ? `was: ${p.compareAtPrice}` : "",
          p.url ? `url: ${p.url}` : "",
          p.externalId ? `id: ${p.externalId}` : "",
          p.images?.length ? `images: ${p.images.slice(0, 8).join(" ")}` : "",
          p.options?.length ? `options: ${p.options.map((o) => `${o.name}=${o.values.join("/")}`).join("; ")}` : "",
          p.variants?.length ? `variants: ${p.variants.slice(0, 25).map((v) => `${v.title}${v.price != null ? ` @${v.price}` : ""}${v.stock != null ? ` stock ${v.stock}` : ""}`).join("; ")}` : "",
          p.soldCount != null ? `sold: ${p.soldCount}` : "",
          p.rating != null ? `rating: ${p.rating} (${p.ratingCount ?? "?"})` : "",
          p.category ? `category: ${p.category}` : "",
          p.tags?.length ? `tags: ${p.tags.join(", ")}` : "",
          p.description ? `description: ${p.description.slice(0, 1200)}` : "",
          `evidence: ${p.via}${p.evidence ? ` (${p.evidence})` : ""}`,
          p.notes?.length ? `notes: ${p.notes.join("; ")}` : "",
        ].filter(Boolean);
        return bits.join("\n   ");
      })
      .join("\n");
    const onlyBatch = input.batchCount > 1;
    const user = [
      `Store: ${input.store.brand.name} (${input.store.brand.industry}); currency ${input.store.commerce.currency}; locale ${input.store.commerce.locale}.`,
      `Categories (use these slugs): ${input.store.categories.map((c) => `${c.slug} = ${c.name}`).join("; ")}`,
      `Return at most ${input.maxProducts} products for this batch.`,
      onlyBatch ? `This is batch ${input.batchIndex + 1} of ${input.batchCount}: only normalize the raw candidates listed below; do not add products from the research brief (another batch handles them).` : "Also include real products that only appear in the research brief, screenshots or scraped text and are missing from the candidates.",
      "Candidates were merged across sources; a 'notes' line flags price disagreements, outliers or archived data - resolve them using the strongest evidence and mention doubts in the description only when material.",
      "",
      "## Raw product candidates",
      raw || "(none)",
      "",
      "## Research brief (products section is most relevant)",
      input.research.skipped ? "(none)" : clampText(input.research.markdown, 25_000),
      "",
      onlyBatch ? "" : "## Gathered material\n" + clampText(summarizeSignalsForPrompt({ sources: input.ingest.sources, texts: input.ingest.texts, attachments: input.ingest.attachments }, 0), 30_000),
    ]
      .filter((l) => l !== "")
      .join("\n");
    const batch = await this.structured({ step: "normalize-products", ctx, system: NORMALIZE_PRODUCTS_SYSTEM, user, schema: ProductBatchDraftSchema, maxTokens: 64_000 });
    return batch.products;
  }

  // ---------- enrich ----------

  async enrich(input: EnrichInput, ctx: GatewayContext): Promise<EnrichmentDraft> {
    ctx.onProgress?.("Designing the store: theme, copy, layout and template…");
    const spec = input.spec;
    const compactSpec = {
      brand: spec.brand,
      theme: spec.theme,
      commerce: spec.commerce,
      social: spec.social,
      categories: spec.catalog.categories,
      products: spec.catalog.products.map((p) => ({ id: p.id, title: p.title, price: p.price, images: p.images.length, shortDescription: p.shortDescription, description: p.description.slice(0, 300), categories: p.categories, tags: p.tags, soldCount: p.soldCount, rating: p.rating, confidence: p.confidence })),
      pages: spec.pages,
      seo: spec.seo,
    };
    const templates = input.templates.map((t) => ({ id: t.id, name: t.name, description: t.description, style: t.style, industries: t.industries, features: t.features, minProducts: t.minProducts, maxProducts: t.maxProducts }));
    const content: Anthropic.Beta.BetaContentBlockParam[] = [];
    for (const p of input.imagePaths.slice(0, 3)) {
      const { blocks } = await this.imageBlocks(p, 1);
      if (blocks[0]) content.push(blocks[0]);
    }
    content.push({
      type: "text",
      text: [
        "Finalize this store. Images above (if any) are the brand's own logo/hero/product photos - use them for palette and mood.",
        input.instructions ? `Merchant instructions: ${input.instructions}` : "",
        `Catalog size: ${spec.catalog.products.length} products, ${spec.catalog.categories.length} categories.`,
        "",
        "## Available templates",
        JSON.stringify(templates, null, 1),
        "",
        "## Current store definition",
        clampText(JSON.stringify(compactSpec, null, 1), 60_000),
      ]
        .filter((l) => l !== "")
        .join("\n"),
    });
    return this.structured({ step: "enrich", ctx, system: ENRICH_SYSTEM, user: content, schema: EnrichmentDraftSchema, maxTokens: 16_000 });
  }
}

/** The SDK reports a response cut off mid-JSON as a parse error, not as a stop reason. */
function isTruncatedOutput(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /failed to parse structured output|unterminated string|unexpected end of (json|input)|in JSON at position/i.test(message);
}

function emptyExtract(a: Attachment, note: string): AttachmentExtract {
  return { attachmentId: a.id, name: a.name, kind: a.kind, platformGuess: "unknown", pageType: "other", shopName: null, handle: null, bio: null, followers: null, rating: null, location: null, contacts: { whatsapp: null, email: null, phone: null, website: null }, socialHandles: [], products: [], visibleText: "", notes: note, confidence: 0, via: "none" };
}
