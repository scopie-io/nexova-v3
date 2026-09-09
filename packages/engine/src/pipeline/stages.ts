/**
 * Pipeline stages as standalone functions.
 *
 * Every stage reads what it needs from the job's artifacts and writes its output back as
 * artifacts, so state never lives in memory between stages. That lets the same code run
 *   - in one process (runJob in pipeline.ts: the local server and the CLI), and
 *   - as durable Workflow steps on Vercel, where each stage is its own function invocation.
 *
 * `runStep` wraps a stage with the bookkeeping the web app relies on: step status, attempts,
 * messages and events on the job record.
 */
import path from "node:path";
import type { GatewayContext } from "../claude/gateway.js";
import { NexovaError } from "../claude/gateway.js";
import { applyEnrichment, buildSpec, evidenceFromSignals, productsFromSignals } from "../claude/mapping.js";
import { chooseTemplateByRules } from "../claude/offline-gateway.js";
import { CURRENCY_BY_REGION, LOCALE_BY_REGION, detectInput, expandShortLinks } from "../ingest/detect.js";
import { assemble, captureAttachments, ingestUrls, processAttachments, runDiscovery } from "../ingest/ingest.js";
import { coverageSummary } from "../ingest/coverage.js";
import { localizeAssets } from "../generate/assets.js";
import { buildSite } from "../generate/build.js";
import { composeSite, composeSiteFiles } from "../generate/compose.js";
import type { StoreDraft, ProductDraft } from "../schema/drafts.js";
import type { JobEvent, JobProductPreview, JobRecord, StepName, StepState } from "../schema/job.js";
import type { TemplateEntry } from "../schema/manifest.js";
import type { AttachmentExtract, DetectedUrl, IngestInput, IngestResult, RawProduct, ResearchFindings, SourceSignals } from "../schema/signals.js";
import { parseStoreSpec, type SourceRecord, type StoreSpec } from "../schema/store-spec.js";
import { errorMessage, type Logger } from "../util/log.js";
import { mapLimit, withTimeout } from "../util/retry.js";
import type { PipelineDeps } from "./pipeline.js";

/** Products per normalization call. Kept modest so one batch's JSON stays inside the output budget. */
export const PRODUCT_BATCH = 12;

/** Product batches to normalize at once. Bounded so a big catalog does not trip rate limits. */
const NORMALIZE_CONCURRENCY = 3;

export class StepFailure extends Error {
  constructor(
    public readonly step: StepName,
    message: string,
  ) {
    super(message);
    this.name = "StepFailure";
  }
}

export const SKIP = Symbol("skip");
export type StepOutcome = string | { skip: string };

export interface StageContext {
  deps: PipelineDeps;
  job: JobRecord;
  log: Logger;
  signal: AbortSignal;
  publish: (event: JobEvent) => void;
}

export function progress(ctx: StageContext, step: StepName, message: string): void {
  ctx.publish({ type: "progress", jobId: ctx.job.id, step, message, at: new Date().toISOString() });
}

/**
 * Push the first products onto the merchant's screen as soon as ingestion has them. The rest of
 * the build takes minutes; a grid of their own products beats a spinner while it runs.
 */
export function publishProducts(ctx: StageContext, ingest: IngestResult): void {
  if (!ingest.products.length) return;
  const products: JobProductPreview[] = ingest.products.slice(0, 12).map((p) => ({
    title: p.title,
    priceText: p.priceText ?? (typeof p.price === "number" && p.price > 0 ? `${p.currency ?? ""} ${p.price}`.trim() : ""),
    image: p.images?.find((u) => /^https?:\/\//i.test(u)) ?? null,
  }));
  ctx.publish({ type: "products", jobId: ctx.job.id, products, total: ingest.products.length, at: new Date().toISOString() });
}

export function gatewayCtx(ctx: StageContext, step: StepName): GatewayContext {
  return { jobId: ctx.job.id, signal: ctx.signal, onProgress: (m) => progress(ctx, step, m) };
}

function ingestOpts(ctx: StageContext, step: StepName) {
  const { deps, job } = ctx;
  return { config: deps.config, log: ctx.log.child("ingest"), signal: ctx.signal, storage: deps.storage, captureDir: deps.jobs.captureDir(job.id), jobId: job.id, onProgress: (m: string) => progress(ctx, step, m) };
}

async function artifact<T>(ctx: StageContext, name: string): Promise<T> {
  const value = await ctx.deps.jobs.getArtifact<T>(ctx.job, name);
  if (value == null) throw new StepFailure("detect", `job artifact "${name}" is missing; an earlier step did not complete`);
  return value;
}

async function optionalArtifact<T>(ctx: StageContext, name: string): Promise<T | null> {
  return ctx.deps.jobs.getArtifact<T>(ctx.job, name);
}

export async function setStatus(ctx: StageContext, status: JobRecord["status"]): Promise<void> {
  ctx.job.status = status;
  await ctx.deps.jobs.save(ctx.job);
  ctx.publish({ type: "status", jobId: ctx.job.id, status, at: new Date().toISOString() });
}

/**
 * Run one stage with status tracking. Retries once for the steps whose failures are usually
 * transient model hiccups; "research" handles its own failure and must never be paid for twice.
 */
export async function runStep(ctx: StageContext, name: StepName, fn: () => Promise<StepOutcome>): Promise<void> {
  if (ctx.signal.aborted) throw new Error("cancelled");
  const st = ctx.job.steps.find((s) => s.name === name)!;
  st.status = "running";
  st.startedAt = new Date().toISOString();
  st.attempts += 1;
  st.error = null;
  await ctx.deps.jobs.save(ctx.job);
  ctx.publish({ type: "step", jobId: ctx.job.id, step: { ...st }, at: st.startedAt });
  ctx.log.info(`▶ ${name}`);
  const maxAttempts = name === "normalize" || name === "enrich" || name === "attachments" ? 2 : 1;
  try {
    let outcome: StepOutcome | undefined;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        outcome = await fn();
        break;
      } catch (err) {
        const retryable = err instanceof NexovaError ? err.retryable : !(err instanceof StepFailure) && attempt < maxAttempts && !ctx.signal.aborted;
        if (!retryable || attempt >= maxAttempts) throw err;
        ctx.log.warn(`${name} attempt ${attempt} failed, retrying: ${errorMessage(err)}`);
        st.attempts += 1;
      }
    }
    st.endedAt = new Date().toISOString();
    if (outcome && typeof outcome === "object" && "skip" in outcome) {
      st.status = "skipped";
      st.message = outcome.skip;
      ctx.log.info(`↷ ${name} skipped: ${outcome.skip}`);
    } else {
      st.status = "done";
      st.message = (outcome as string | undefined) ?? "";
      ctx.log.info(`✓ ${name}: ${st.message}`);
    }
  } catch (err) {
    st.status = "failed";
    st.endedAt = new Date().toISOString();
    st.error = errorMessage(err);
    st.message = st.error;
    await ctx.deps.jobs.save(ctx.job);
    ctx.publish({ type: "step", jobId: ctx.job.id, step: { ...st }, at: st.endedAt });
    throw new StepFailure(name, `${name}: ${st.error}`);
  }
  await ctx.deps.jobs.save(ctx.job);
  ctx.publish({ type: "step", jobId: ctx.job.id, step: { ...st }, at: st.endedAt! });
}

/** Mark a stage as skipped for a rebuild, without running anything. */
export async function skipStep(ctx: StageContext, name: StepName, reason: string): Promise<void> {
  await runStep(ctx, name, async () => ({ skip: reason }));
}

// ---------------------------------------------------------------------------------------------
// Stages. Artifacts: input, sources, discovery, discovered, ingest, coverage, research(.md),
// store.draft, products.draft.<i>, products.draft, spec.draft, spec.assets, image-refs,
// enrichment, spec, template, site
// ---------------------------------------------------------------------------------------------

export async function stageDetect(ctx: StageContext): Promise<StepOutcome> {
  const { job, deps } = ctx;
  const det = await expandShortLinks(detectInput(job.input.raw), { timeoutMs: deps.config.fetchTimeoutMs, signal: ctx.signal });
  const input: IngestInput = { ...det, attachments: job.input.attachments ?? [] };
  if (input.urls.length === 0 && input.texts.length === 0 && input.attachments.length === 0) throw new StepFailure("detect", "Paste at least one link (TikTok, Instagram, Shopee, Facebook, Lazada, Shopify or a website), a product list, or attach screenshots.");
  await deps.jobs.putArtifact(job, "input", input);
  return `${input.urls.length} link(s): ${input.urls.map((u) => `${u.platform}/${u.kind}`).join(", ") || "none"}${input.texts.length ? `; ${input.texts.length} text line(s)` : ""}${input.attachments.length ? `; ${input.attachments.length} attachment(s)` : ""}`;
}

export async function stageIngest(ctx: StageContext): Promise<StepOutcome> {
  const { job, deps } = ctx;
  const input = await artifact<IngestInput>(ctx, "input");
  if (!input.urls.length) {
    await deps.jobs.putArtifact(job, "sources", []);
    return { skip: "no links pasted" };
  }
  const sources = await ingestUrls(input.urls, { ...ingestOpts(ctx, "ingest"), onSource: (s) => progress(ctx, "ingest", `${s.platform} ${s.kind}: ${s.status}${s.products.length ? `, ${s.products.length} products` : ""}${s.profile ? ", profile found" : ""}`) });
  await deps.jobs.putArtifact(job, "sources", sources);
  const ok = sources.filter((s) => s.status === "ok" || s.status === "partial").length;
  const products = sources.reduce((n, s) => n + s.products.length, 0);
  const strategies = [...new Set(sources.flatMap((s) => s.providers))];
  return `${ok}/${sources.length} sources readable, ${products} raw products, ${sources.filter((s) => s.profile).length} profiles via ${strategies.join(", ") || "nothing"}`;
}

export async function stageDiscover(ctx: StageContext): Promise<StepOutcome> {
  const { job, deps } = ctx;
  const sources = (await optionalArtifact<SourceSignals[]>(ctx, "sources")) ?? [];
  if (job.input.options.skipDiscovery || !deps.config.discovery) return { skip: "discovery disabled" };
  if (!sources.length) return { skip: "nothing to expand from" };
  const input = await artifact<IngestInput>(ctx, "input");
  const { result, newSources } = await runDiscovery(sources, input, ingestOpts(ctx, "discover"));
  await deps.jobs.putArtifact(job, "discovered", result.candidates);
  await deps.jobs.putArtifact(job, "sources", [...sources, ...newSources]);
  await deps.jobs.putArtifact(job, "discovery", { ...result, newSources: newSources.map((s) => ({ url: s.url, status: s.status, products: s.products.length })) });
  if (!result.candidates.length) return { skip: `no extra channels found${result.bioPagesFetched.length ? ` (checked ${result.bioPagesFetched.length} bio page)` : ""}` };
  const readable = newSources.filter((s) => s.status === "ok" || s.status === "partial");
  return `${result.candidates.length} extra channel(s): ${result.candidates.map((c) => `${c.platform}/${c.kind}`).join(", ")}; ${readable.length} readable, +${newSources.reduce((n, s) => n + s.products.length, 0)} products`;
}

export async function stageAttachments(ctx: StageContext): Promise<StepOutcome> {
  const { job, deps } = ctx;
  const input = await artifact<IngestInput>(ctx, "input");
  const sources = (await optionalArtifact<SourceSignals[]>(ctx, "sources")) ?? [];
  const discovered = (await optionalArtifact<DetectedUrl[]>(ctx, "discovered")) ?? [];
  const uploads = input.attachments;
  const captures = captureAttachments(sources);
  const all = [...uploads, ...captures];
  const vision = deps.config.offline ? undefined : (images: typeof all) => deps.gateway.extractFromAttachments({ images, context: `Pasted links: ${input.urls.map((u) => `${u.platform} ${u.kind} ${u.url}`).join(", ") || "none"}. Pasted text: ${input.texts.join(" | ").slice(0, 500)}` }, gatewayCtx(ctx, "attachments"));
  const extracts: AttachmentExtract[] = all.length ? await processAttachments(all, ingestOpts(ctx, "attachments"), vision) : [];
  const region = sources.map((s) => s.region).find(Boolean) ?? null;
  const currencyHint = job.input.options.currency?.toUpperCase() || (region ? CURRENCY_BY_REGION[region] ?? null : null);
  const ingest = assemble(sources, input.texts, extracts, discovered, currencyHint);
  await deps.jobs.putArtifact(job, "ingest", ingest);
  await deps.jobs.putArtifact(job, "coverage", ingest.coverage);
  publishProducts(ctx, ingest);
  const imgCount = all.filter((a) => a.kind === "image").length;
  const attNote = all.length ? `${uploads.length} upload(s)${captures.length ? ` + ${captures.length} capture(s)` : ""}: ${extracts.reduce((n, a) => n + a.products.length, 0)} products read${deps.config.offline && imgCount ? " (screenshots need Claude)" : ""}` : "no attachments";
  return `${attNote}. ${coverageSummary(ingest.coverage)}`;
}

export async function stageResearch(ctx: StageContext, opts: { timeoutMs?: number } = {}): Promise<StepOutcome> {
  const { job, deps } = ctx;
  if (job.input.options.skipResearch) return { skip: "skipped by request" };
  if (deps.config.offline) return { skip: "offline mode (no ANTHROPIC_API_KEY)" };
  const ingest = await artifact<IngestResult>(ctx, "ingest");
  const fast = fastPathReason(job, ingest, deps.config);
  if (fast) return { skip: `not needed: ${fast}` };
  // Research enriches the store, it does not gate it. A timeout, a refusal or a provider
  // outage degrades this step to "skipped" instead of costing the merchant their build.
  let findings: ResearchFindings;
  try {
    findings = await withTimeout(deps.gateway.research({ ingest, instructions: job.input.options.instructions ?? null }, gatewayCtx(ctx, "research")), opts.timeoutMs ?? deps.config.researchTimeoutMs, "research");
  } catch (err) {
    const reason = errorMessage(err);
    ctx.log.warn(`research unavailable, continuing without it: ${reason}`);
    ingest.coverage.gaps.push(`Web research did not complete (${reason.slice(0, 120)}), so gaps were not filled from the web.`);
    await deps.jobs.putArtifact(job, "ingest", ingest);
    return { skip: `unavailable: ${reason.slice(0, 120)}` };
  }
  await deps.jobs.putArtifact(job, "research.md", findings.markdown || "(empty)");
  await deps.jobs.putArtifact(job, "research", { ...findings, markdown: findings.markdown });
  if (findings.skipped) return { skip: "research returned nothing" };
  return `${findings.searches} searches, ${findings.fetches} page reads, ${findings.citations.length} sources, ${Math.round(findings.markdown.length / 4)} tokens of notes`;
}

const EMPTY_RESEARCH: ResearchFindings = { markdown: "", citations: [], searches: 0, fetches: 0, skipped: true };

function hints(ingest: IngestResult, job: JobRecord) {
  const region = ingest.sources.map((s) => s.region).find(Boolean) ?? null;
  const currencyHint = job.input.options.currency?.toUpperCase() || (region ? CURRENCY_BY_REGION[region] ?? null : null) || ingest.products.map((p) => p.currency).find(Boolean) || null;
  const localeHint = region ? LOCALE_BY_REGION[region] ?? null : null;
  return { currencyHint, localeHint };
}

export function productBatches(ingest: IngestResult): RawProduct[][] {
  const batches: RawProduct[][] = [];
  for (let i = 0; i < ingest.products.length; i += PRODUCT_BATCH) batches.push(ingest.products.slice(i, i + PRODUCT_BATCH));
  if (batches.length === 0) batches.push([]);
  return batches;
}

/** Providers that return a real catalog, structured, straight from the platform. */
const CATALOG_APIS = ["tiktok-shop-api", "shopify-products-json", "shopee-api"];

/**
 * Is this job's catalog good enough to skip research and per-product normalization?
 *
 * Returns a human reason when it is (shown in the UI as the skip message), or null when the job
 * must take the full ladder. Deliberately conservative: any screenshot, any pasted product line
 * or any source the API did not cover means the merchant gave us something the API did not know
 * about, and dropping the Claude passes would lose it.
 */
export function fastPathReason(job: JobRecord, ingest: IngestResult, config: PipelineDeps["config"]): string | null {
  if (!config.fastPath || job.input.options.fastPath === "off") return null;
  if (job.input.attachments?.length) return null;
  if (!ingest.products.length) return null;

  const covered = ingest.sources.filter((s) => s.providers.some((p) => CATALOG_APIS.includes(p)));
  if (!covered.length) return null;
  // Every readable source must be one the catalog API handled, or we would silently drop the rest.
  const readable = ingest.sources.filter((s) => s.status === "ok" || s.status === "partial");
  if (readable.some((s) => !covered.includes(s))) return null;

  const api = [...new Set(covered.flatMap((s) => s.providers.filter((p) => CATALOG_APIS.includes(p))))];
  const fromApi = ingest.products.filter((p) => CATALOG_APIS.includes(p.via)).length;
  if (fromApi < ingest.products.length) return null;
  return `${api.join(", ")} returned ${fromApi} products with prices and photos`;
}

/** The fast path needs no product batches; everything else batches as usual. */
export async function plannedBatchCount(ctx: StageContext): Promise<number> {
  const ingest = await artifact<IngestResult>(ctx, "ingest");
  if (fastPathReason(ctx.job, ingest, ctx.deps.config)) return 0;
  return productBatches(ingest).length;
}

export async function stageNormalizeStore(ctx: StageContext): Promise<StoreDraft> {
  const { job, deps } = ctx;
  const ingest = await artifact<IngestResult>(ctx, "ingest");
  const research = (await optionalArtifact<ResearchFindings>(ctx, "research")) ?? EMPTY_RESEARCH;
  const { currencyHint, localeHint } = hints(ingest, job);
  const store = await deps.gateway.normalizeStore({ ingest, research, instructions: job.input.options.instructions ?? null, currencyHint, localeHint }, gatewayCtx(ctx, "normalize"));
  await deps.jobs.putArtifact(job, "store.draft", store);
  return store;
}

/** One batch of products; returns how many are done so far so the caller can stop at maxProducts. */
export async function stageNormalizeProducts(ctx: StageContext, batchIndex: number): Promise<ProductDraft[]> {
  const { job, deps } = ctx;
  const ingest = await artifact<IngestResult>(ctx, "ingest");
  const research = (await optionalArtifact<ResearchFindings>(ctx, "research")) ?? EMPTY_RESEARCH;
  const store = await artifact<StoreDraft>(ctx, "store.draft");
  const batches = productBatches(ingest);
  const already = batchIndex * PRODUCT_BATCH;
  const remaining = Math.max(0, deps.config.maxProducts - already);
  if (remaining <= 0 || batchIndex >= batches.length) {
    await deps.jobs.putArtifact(job, `products.draft.${batchIndex}`, []);
    return [];
  }
  const drafts = await deps.gateway.normalizeProducts({ rawProducts: batches[batchIndex], ingest, research, store, batchIndex, batchCount: batches.length, maxProducts: Math.min(remaining, PRODUCT_BATCH + 10) }, gatewayCtx(ctx, "normalize"));
  await deps.jobs.putArtifact(job, `products.draft.${batchIndex}`, drafts);
  return drafts;
}

/** Merge product batches, reserve the slug, build the spec. */
export async function stageBuildSpec(ctx: StageContext): Promise<StepOutcome> {
  const { job, deps } = ctx;
  const ingest = await artifact<IngestResult>(ctx, "ingest");
  const store = await artifact<StoreDraft>(ctx, "store.draft");
  const products: ProductDraft[] = [];
  const fast = fastPathReason(job, ingest, deps.config);
  if (fast) {
    const { currencyHint } = hints(ingest, job);
    products.push(...productsFromSignals(ingest.products, store, { maxProducts: deps.config.maxProducts, currency: currencyHint ?? store.commerce.currency }));
  } else {
    for (let i = 0; i < productBatches(ingest).length; i++) {
      const batch = await optionalArtifact<ProductDraft[]>(ctx, `products.draft.${i}`);
      if (batch) products.push(...batch);
      if (products.length >= deps.config.maxProducts) break;
    }
  }
  await deps.jobs.putArtifact(job, "products.draft", products);

  const slug = job.slug ?? (await deps.stores.reserveSlug(job.input.options.slug ?? null, store.brand.name));
  job.slug = slug;
  const sources: SourceRecord[] = ingest.sources.map((s) => ({ url: s.url, platform: s.platform, kind: s.kind, handle: s.handle, fetchedAt: s.fetchedAt, status: s.status, providers: s.providers, notes: [s.discovered ? "discovered" : "", ...s.errors.slice(0, 2)].filter(Boolean).join("; ") }));
  const spec = buildSpec(store, products, { id: job.id, slug, engineVersion: deps.config.engineVersion, currencyOverride: job.input.options.currency?.toUpperCase() ?? null, sources, maxProducts: deps.config.maxProducts, evidence: evidenceFromSignals(ingest.sources) });
  if (fast) spec.meta.warnings.push("Products came straight from the marketplace catalog, so titles and prices are exactly as the platform has them.");
  if (spec.catalog.products.length === 0) spec.meta.warnings.push("No products could be extracted. The store is live with an empty catalog; add products in the inventory editor.");
  for (const gap of ingest.coverage.gaps.slice(0, 4)) if (!spec.meta.warnings.includes(gap)) spec.meta.warnings.push(gap);
  await deps.jobs.putArtifact(job, "spec.draft", spec);
  return `${spec.brand.name}: ${spec.catalog.products.length} products, ${spec.catalog.categories.length} categories, currency ${spec.commerce.currency}`;
}

/** The whole normalize step in one go (local mode). */
export async function stageNormalize(ctx: StageContext): Promise<StepOutcome> {
  await stageNormalizeStore(ctx);
  const ingest = await artifact<IngestResult>(ctx, "ingest");
  if (!fastPathReason(ctx.job, ingest, ctx.deps.config)) {
    const wanted = Math.min(productBatches(ingest).length, Math.ceil(ctx.deps.config.maxProducts / PRODUCT_BATCH));
    // Batch 0 alone first: it writes the prompt cache, and measured runs show it costs ~2x what
    // the rest do. Every later batch then reads a warm cache, and they have no reason to wait
    // on each other, so they go out together.
    if (wanted > 0) await stageNormalizeProducts(ctx, 0);
    if (wanted > 1) {
      const rest = Array.from({ length: wanted - 1 }, (_, i) => i + 1);
      const results = await mapLimit(rest, NORMALIZE_CONCURRENCY, (b) => stageNormalizeProducts(ctx, b));
      const failed = results.find((r) => !r.ok);
      if (failed && !failed.ok) throw new StepFailure("normalize", failed.error);
    }
  }
  return stageBuildSpec(ctx);
}

export async function stageAssets(ctx: StageContext): Promise<StepOutcome> {
  const { job, deps } = ctx;
  const spec = await artifact<StoreSpec>(ctx, "spec.draft");
  const ingest = await optionalArtifact<IngestResult>(ctx, "ingest");
  const referer = ingest?.sources[0]?.url ?? null;
  const result = await localizeAssets(spec, { storage: deps.storage, slug: job.slug!, log: ctx.log.child("assets"), signal: ctx.signal, referer });
  await deps.jobs.putArtifact(job, "spec.assets", result.spec);
  await deps.jobs.putArtifact(job, "image-refs", result.representative);
  return `${result.downloaded} images downloaded, ${result.skipped} reused, ${result.failed} failed`;
}

/**
 * Publish the store before enrichment runs, so the merchant gets a live URL to look at while
 * Claude is still polishing copy and theme (measured at 32-47s). Compose+build+deploy on the
 * local deployer costs under a second, so this is close to free.
 *
 * Not done for source-building deployers (Vercel) yet: there a publish means uploading every file
 * and waiting on a remote build, so a second one is a real cost that has to be measured first.
 */
export async function stagePreview(ctx: StageContext): Promise<StepOutcome> {
  const { job, deps } = ctx;
  if (!deps.config.earlyPublish) return { skip: "disabled" };
  if (job.input.options.skipBuild) return { skip: "nothing to publish" };
  if (deps.deployer.deploySource) return { skip: `${deps.deployer.id} builds from source; publishing once at the end` };
  const spec = await optionalArtifact<StoreSpec>(ctx, "spec.assets");
  if (!spec) return { skip: "no spec yet" };
  if (!spec.catalog.products.length) return { skip: "no products to show yet" };

  // enrich reads spec.assets and writes spec, so seeding spec here is overwritten later, not lost.
  await deps.jobs.putArtifact(job, "spec", spec);
  await stageTemplate(ctx);
  await stageCompose(ctx);
  await stageBuild(ctx);
  await stageDeploy(ctx);
  if (!job.siteUrl) return { skip: "nothing deployed" };
  job.preview = true;
  await deps.jobs.save(job);
  return `live at ${job.siteUrl} while the copy and theme are finished`;
}

export async function stageEnrich(ctx: StageContext): Promise<StepOutcome> {
  const { job, deps } = ctx;
  const spec = await artifact<StoreSpec>(ctx, "spec.assets");
  const imageRefs = (await optionalArtifact<string[]>(ctx, "image-refs")) ?? [];
  const manifests = await deps.registry.manifests();
  const enrichment = await deps.gateway.enrich({ spec, templates: manifests, imagePaths: imageRefs, instructions: job.input.options.instructions ?? null }, gatewayCtx(ctx, "enrich"));
  await deps.jobs.putArtifact(job, "enrichment", enrichment);
  const next = applyEnrichment(spec, enrichment, manifests.map((m) => m.id));
  await deps.jobs.putArtifact(job, "spec", next);
  return `theme ${next.theme.preset}/${next.theme.mode}, ${next.pages.home.featuredProductIds.length} featured, template suggestion: ${next.template.id ?? "none"}`;
}

export async function stageTemplate(ctx: StageContext, source: "spec" | "store" = "spec"): Promise<StepOutcome> {
  const { job, deps } = ctx;
  let spec: StoreSpec;
  if (source === "store") {
    const saved = await deps.stores.getSpec(job.slug!);
    if (!saved) throw new StepFailure("template", `store ${job.slug} not found`);
    spec = saved;
  } else spec = await artifact<StoreSpec>(ctx, "spec");
  const entries = await deps.registry.list(true);
  if (entries.length === 0) throw new StepFailure("template", `No templates found in ${deps.config.templatesDir}. Add at least one folder with nexova.template.json.`);
  const wanted = job.input.options.templateId ?? spec.template.id ?? null;
  let entry = wanted ? entries.find((e) => e.manifest.id === wanted) ?? null : null;
  let reason = spec.template.reason || (source === "store" ? "rebuild" : "");
  if (!entry) {
    const chosen = chooseTemplateByRules(entries.map((e) => e.manifest), spec);
    entry = entries.find((e) => e.manifest.id === chosen?.id) ?? entries[0];
    reason = wanted ? `requested template "${wanted}" not found; picked ${entry.manifest.id} by rules` : `picked by rules`;
  }
  spec.template = { id: entry.manifest.id, reason };
  job.templateId = entry.manifest.id;
  await deps.jobs.putArtifact(job, "spec", spec);
  await deps.jobs.putArtifact(job, "template", { manifest: entry.manifest, dir: entry.dir } satisfies TemplateEntry);
  return `${entry.manifest.name} (${entry.manifest.id}) — ${reason}`;
}

/** The template picked for this job, resolved to the live registry entry (with bundled files when there are any). */
async function templateFor(ctx: StageContext): Promise<TemplateEntry> {
  const saved = await artifact<TemplateEntry>(ctx, "template");
  return (await ctx.deps.registry.get(saved.manifest.id)) ?? saved;
}

export interface SiteArtifact {
  siteDir: string;
  basePath: string;
  distDir?: string;
}

export async function stageCompose(ctx: StageContext): Promise<StepOutcome> {
  const { job, deps } = ctx;
  const spec = parseStoreSpec(await artifact<StoreSpec>(ctx, "spec"));
  const template = await templateFor(ctx);
  const basePath = deps.deployer.basePath(job.slug!);
  await deps.stores.saveSpec(spec);
  await deps.stores.updateMeta(spec.slug, { jobId: job.id, templateId: template.manifest.id });
  const result = await composeSite({ spec, template, config: deps.config, log: ctx.log.child("compose"), basePath });
  await deps.jobs.putArtifact(job, "site", { siteDir: result.siteDir, basePath } satisfies SiteArtifact);
  return `${result.filesCopied} files at ${path.relative(deps.config.rootDir, result.siteDir)}`;
}

export async function stageBuild(ctx: StageContext): Promise<StepOutcome> {
  const { job, deps } = ctx;
  if (job.input.options.skipBuild) return { skip: "skipped by request" };
  const site = await artifact<SiteArtifact>(ctx, "site");
  const template = await templateFor(ctx);
  // Templates on disk share one node_modules; a bundled template installs inside the site folder (buildSite does that).
  if (template.dir) await deps.registry.ensureInstalled(template, ctx.log.child("install"), ctx.signal);
  const result = await buildSite({ siteDir: site.siteDir, template, basePath: site.basePath, slug: job.slug!, log: ctx.log.child("build"), signal: ctx.signal, onLine: (line) => progress(ctx, "build", line) });
  await deps.jobs.putArtifact(job, "site", { ...site, distDir: result.outDir } satisfies SiteArtifact);
  return `built in ${Math.round(result.durationMs / 1000)}s`;
}

export async function stageDeploy(ctx: StageContext): Promise<StepOutcome> {
  const { job, deps } = ctx;
  const site = await optionalArtifact<SiteArtifact>(ctx, "site");
  if (job.input.options.skipBuild || !site?.distDir) return { skip: "nothing to deploy" };
  const spec = await artifact<StoreSpec>(ctx, "spec");
  const result = await deps.deployer.deploy({ slug: job.slug!, distDir: site.distDir, spec, log: ctx.log.child("deploy"), signal: ctx.signal });
  job.siteUrl = result.url;
  await deps.stores.updateMeta(job.slug!, { siteUrl: result.url, builtAt: new Date().toISOString(), deployProvider: result.provider, jobId: job.id, templateId: job.templateId });
  return `live at ${result.url}`;
}

/**
 * Compose + build + deploy in one go, for hosts where these must happen inside a single invocation
 * (no persistent disk between steps). With a deployer that builds from source (Vercel) the build
 * step is skipped locally; otherwise it falls back to the on-disk compose/build/deploy.
 */
export async function stagePublish(ctx: StageContext): Promise<void> {
  const { job, deps } = ctx;
  if (!deps.deployer.deploySource || job.input.options.skipBuild) {
    await runStep(ctx, "compose", () => stageCompose(ctx));
    await runStep(ctx, "build", () => stageBuild(ctx));
    await runStep(ctx, "deploy", () => stageDeploy(ctx));
    return;
  }
  let files: Record<string, Uint8Array | string> = {};
  let template: TemplateEntry | null = null;
  let spec: StoreSpec | null = null;
  await runStep(ctx, "compose", async () => {
    spec = parseStoreSpec(await artifact<StoreSpec>(ctx, "spec"));
    template = await templateFor(ctx);
    const basePath = deps.deployer.basePath(job.slug!);
    await deps.stores.saveSpec(spec);
    await deps.stores.updateMeta(spec.slug, { jobId: job.id, templateId: template.manifest.id });
    files = await composeSiteFiles({ spec, template, config: deps.config, basePath });
    await deps.jobs.putArtifact(job, "site", { siteDir: "", basePath } satisfies SiteArtifact);
    return `${Object.keys(files).length} files composed in memory`;
  });
  await runStep(ctx, "build", async () => ({ skip: `built by ${deps.deployer.id}` }));
  await runStep(ctx, "deploy", async () => {
    const result = await deps.deployer.deploySource!({ slug: job.slug!, files, framework: "vite", buildCommand: template!.manifest.build.build, outputDir: template!.manifest.build.outDir, basePath: deps.deployer.basePath(job.slug!), spec: spec!, log: ctx.log.child("deploy"), signal: ctx.signal });
    job.siteUrl = result.url;
    await deps.stores.updateMeta(job.slug!, { siteUrl: result.url, builtAt: new Date().toISOString(), deployProvider: result.provider, jobId: job.id, templateId: job.templateId });
    return `live at ${result.url}`;
  });
}

export async function finishJob(ctx: StageContext): Promise<JobRecord> {
  const { job, deps } = ctx;
  job.status = "done";
  job.error = null;
  job.preview = false; // the final publish has replaced whatever stagePreview put up
  await deps.jobs.save(job);
  ctx.publish({ type: "status", jobId: job.id, status: "done", at: new Date().toISOString() });
  ctx.publish({ type: "done", jobId: job.id, job, at: new Date().toISOString() });
  ctx.log.info(`job done${job.siteUrl ? `: ${job.siteUrl}` : ""}`, { costUsd: job.usage.costUsd });
  return job;
}

export async function failJob(ctx: StageContext, err: unknown): Promise<JobRecord> {
  const { job, deps } = ctx;
  const message = errorMessage(err);
  job.status = ctx.signal.aborted ? "cancelled" : "failed";
  job.error = message;
  await deps.jobs.save(job);
  ctx.publish({ type: "status", jobId: job.id, status: job.status, at: new Date().toISOString() });
  ctx.publish({ type: "error", jobId: job.id, error: message, at: new Date().toISOString() });
  ctx.log.error(`job ${job.status}: ${message}`);
  return job;
}

export type { StepState };
