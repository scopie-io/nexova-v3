/**
 * Ingestion orchestrator.
 *
 *   ingestUrls()        run the provider ladder for each URL (cache -> always-providers -> fallback-providers)
 *   runDiscovery()      follow bio links / on-page links / search to find the merchant's other channels
 *   processAttachments() parse spreadsheets locally, send screenshots to vision (via callback)
 *   assemble()          merge products across sources with provenance precedence, sanity-check, coverage report
 *   ingest()            convenience: all of the above for callers outside the pipeline
 */
import type { EngineConfig } from "../config.js";
import { emptySignals, type Attachment, type AttachmentExtract, type DetectedUrl, type IngestInput, type IngestResult, type RawProduct, type SourceSignals } from "../schema/signals.js";
import { rawProductsFromTexts } from "../claude/mapping.js";
import { errorMessage, type Logger } from "../util/log.js";
import { newId } from "../util/ids.js";
import { mapLimit, withTimeout } from "../util/retry.js";
import { extractLocalAttachments, imageAttachments } from "./attachments.js";
import { SourceCache } from "./cache.js";
import { buildCoverage } from "./coverage.js";
import { CURRENCY_BY_REGION } from "./detect.js";
import { discoverSources, type DiscoveryResult } from "./discover.js";
import { mergeProducts, sanityCheck } from "./merge.js";
import { directFetchProvider } from "./providers/direct-fetch.js";
import { platformProviders } from "./providers/platforms.js";
import { playwrightProvider } from "./providers/playwright.js";
import { readerProviders } from "./providers/reader.js";
import { tiktokShopApiProvider } from "./providers/tiktok-shop-api.js";
import type { Provider, ProviderContext } from "./providers/types.js";
import { waybackProvider } from "./providers/wayback.js";

export interface IngestOptions {
  config: EngineConfig;
  log: Logger;
  signal?: AbortSignal;
  providers?: Provider[];
  onSource?: (s: SourceSignals) => void;
  onProgress?: (message: string) => void;
  /** Directory for browser/reader screenshots (fed to vision). */
  captureDir?: string;
  jobId?: string | null;
}

export function defaultProviders(): Provider[] {
  return [directFetchProvider, tiktokShopApiProvider, ...platformProviders, ...readerProviders, waybackProvider, playwrightProvider].sort((a, b) => a.priority - b.priority);
}

export async function ingestUrls(urls: DetectedUrl[], opts: IngestOptions, meta: { discovered?: boolean; discoveredFrom?: Map<string, string> } = {}): Promise<SourceSignals[]> {
  const providers = opts.providers ?? defaultProviders();
  const cache = new SourceCache(opts.config);
  const ctx: ProviderContext = { config: opts.config, log: opts.log, signal: opts.signal, captureDir: opts.captureDir, jobId: opts.jobId };

  const results = await mapLimit(urls, 3, async (det) => {
    const cached = await cache.get(det.url);
    if (cached) {
      opts.log.info(`cache hit ${det.platform}/${det.kind} ${det.url}`);
      cached.discovered = !!meta.discovered;
      cached.discoveredFrom = meta.discoveredFrom?.get(det.url) ?? null;
      opts.onSource?.(cached);
      return cached;
    }
    const signals = emptySignals(det, det.url, newId("src"));
    signals.discovered = !!meta.discovered;
    signals.discoveredFrom = meta.discoveredFrom?.get(det.url) ?? null;
    for (const stage of ["always", "fallback"] as const) {
      for (const provider of providers) {
        if ((provider.stage ?? "always") !== stage) continue;
        if (!provider.supports(det, ctx)) continue;
        if (opts.signal?.aborted) break;
        const started = Date.now();
        const before = { products: signals.products.length, status: signals.status, profile: !!signals.profile, text: signals.text.length, errors: signals.errors.length };
        try {
          await withTimeout(provider.run(det, signals, ctx), Math.max(opts.config.fetchTimeoutMs * 4, 60_000), provider.id);
          const gained = signals.products.length > before.products || (!before.profile && !!signals.profile) || signals.text.length > before.text + 200 || (before.status !== "ok" && signals.status === "ok");
          const ran = signals.errors.length > before.errors || gained || stage === "always";
          if (gained) signals.providers.push(provider.id);
          if (ran) signals.attempts.push({ provider: provider.id, ok: gained, ms: Date.now() - started, note: gained ? `+${signals.products.length - before.products} products` : signals.errors.slice(before.errors).join("; ").slice(0, 160) });
          opts.log.debug(`${provider.id} ${gained ? "ok" : "no gain"} in ${Date.now() - started}ms`, { url: det.url, products: signals.products.length, status: signals.status });
        } catch (err) {
          signals.errors.push(`${provider.id}: ${errorMessage(err)}`);
          signals.attempts.push({ provider: provider.id, ok: false, ms: Date.now() - started, note: errorMessage(err).slice(0, 160) });
          opts.log.warn(`${provider.id} failed`, { url: det.url, error: errorMessage(err) });
        }
        opts.onProgress?.(`${det.platform} ${det.kind}: ${provider.id} → ${signals.products.length} products${signals.profile ? ", profile" : ""} (${signals.status})`);
      }
    }
    dedupeWithinSource(signals);
    if (signals.status === "skipped") signals.status = signals.errors.length ? "failed" : "partial";
    if (signals.status === "blocked" && (signals.products.length || signals.profile)) signals.status = "partial";
    signals.fetchedAt = new Date().toISOString();
    await cache.set(det.url, signals);
    opts.onSource?.(signals);
    return signals;
  });

  const sources: SourceSignals[] = [];
  results.forEach((r, i) => {
    if (r.ok) sources.push(r.value);
    else {
      const det = urls[i];
      const s = emptySignals(det, det.url, newId("src"));
      s.status = "failed";
      s.errors.push(r.error);
      sources.push(s);
    }
  });
  return sources;
}

export async function runDiscovery(sources: SourceSignals[], input: IngestInput, opts: IngestOptions): Promise<{ result: DiscoveryResult; newSources: SourceSignals[] }> {
  const result = await discoverSources(sources, { config: opts.config, log: opts.log, signal: opts.signal, existing: input.urls });
  if (!result.candidates.length) return { result, newSources: [] };
  opts.onProgress?.(`found ${result.candidates.length} more channel(s): ${result.candidates.map((c) => `${c.platform}/${c.kind}`).join(", ")}`);
  const from = new Map(result.candidates.map((c) => [c.url, c.from]));
  const newSources = await ingestUrls(
    result.candidates.map(({ from: _f, trust: _t, ...det }) => det),
    opts,
    { discovered: true, discoveredFrom: from },
  );
  return { result, newSources };
}

export async function processAttachments(attachments: Attachment[], opts: IngestOptions, vision?: (images: Attachment[]) => Promise<AttachmentExtract[]>): Promise<AttachmentExtract[]> {
  const local = await extractLocalAttachments(attachments);
  const images = imageAttachments(attachments).slice(0, opts.config.maxVisionImages);
  let visual: AttachmentExtract[] = [];
  if (images.length && !vision) {
    visual = images.map((a) => ({ attachmentId: a.id, name: a.name, kind: a.kind, platformGuess: "unknown", pageType: "other", shopName: null, handle: null, bio: null, followers: null, rating: null, location: null, contacts: { whatsapp: null, email: null, phone: null, website: null }, socialHandles: [], products: [], visibleText: "", notes: "screenshot reading requires Claude (add ANTHROPIC_API_KEY)", confidence: 0, via: "none" }));
  } else if (images.length && vision) {
    try {
      visual = await vision(images);
    } catch (err) {
      opts.log.warn(`vision extraction failed: ${errorMessage(err)}`);
      visual = images.map((a) => ({ attachmentId: a.id, name: a.name, kind: a.kind, platformGuess: "unknown", pageType: "other", shopName: null, handle: null, bio: null, followers: null, rating: null, location: null, contacts: { whatsapp: null, email: null, phone: null, website: null }, socialHandles: [], products: [], visibleText: "", notes: `vision failed: ${errorMessage(err)}`, confidence: 0, via: "none" }));
    }
  }
  return [...local, ...visual];
}

/** Turn browser/reader screenshots into capture attachments so vision can read them like uploads. */
export function captureAttachments(sources: SourceSignals[]): Attachment[] {
  const out: Attachment[] = [];
  for (const s of sources) {
    for (const p of s.screenshots) {
      out.push({ id: newId("cap"), name: `${s.platform}-${s.kind}-capture.png`, mime: "image/png", kind: "image", path: p, size: 0, origin: "capture" });
    }
  }
  return out;
}

export function assemble(sources: SourceSignals[], texts: string[], attachments: AttachmentExtract[], discovered: DetectedUrl[], currencyHint: string | null): IngestResult {
  const region = sources.map((s) => s.region).find(Boolean) ?? null;
  const textProducts = rawProductsFromTexts(texts, region);
  const all: RawProduct[] = [...sources.flatMap((s) => s.products), ...attachments.flatMap((a) => a.products), ...textProducts];
  const merged = mergeProducts(all);
  const hint = currencyHint || (region ? CURRENCY_BY_REGION[region] ?? null : null) || merged.map((p) => p.currency).find(Boolean) || null;
  const products = sanityCheck(merged, hint);
  const coverage = buildCoverage(sources, attachments, products, discovered, texts);
  return { sources, texts, attachments, discovered, products, coverage };
}

/** Convenience for callers outside the pipeline (CLI tools, tests). */
export async function ingest(input: IngestInput, opts: IngestOptions, vision?: (images: Attachment[]) => Promise<AttachmentExtract[]>): Promise<IngestResult> {
  let sources = await ingestUrls(input.urls, opts);
  let discovered: DetectedUrl[] = [];
  if (opts.config.discovery) {
    const d = await runDiscovery(sources, input, opts);
    discovered = d.result.candidates;
    sources = [...sources, ...d.newSources];
  }
  const attachments = await processAttachments([...input.attachments, ...captureAttachments(sources)], opts, vision);
  return assemble(sources, input.texts, attachments, discovered, null);
}

function dedupeWithinSource(signals: SourceSignals): void {
  const seen = new Map<string, number>();
  const out: typeof signals.products = [];
  for (const p of signals.products) {
    const key = (p.externalId ?? p.url ?? p.title).toLowerCase().trim();
    const idx = seen.get(key);
    if (idx === undefined) {
      seen.set(key, out.length);
      out.push({ ...p, images: [...new Set(p.images ?? [])] });
    } else {
      const existing = out[idx];
      existing.description = existing.description || p.description;
      existing.price = existing.price ?? p.price;
      existing.currency = existing.currency ?? p.currency;
      existing.images = [...new Set([...(existing.images ?? []), ...(p.images ?? [])])];
      existing.variants = existing.variants?.length ? existing.variants : p.variants;
      existing.options = existing.options?.length ? existing.options : p.options;
      existing.soldCount = existing.soldCount ?? p.soldCount;
      existing.rating = existing.rating ?? p.rating;
    }
  }
  signals.products = out;
}

export interface PromptMaterial {
  sources: SourceSignals[];
  texts: string[];
  attachments?: AttachmentExtract[];
  products?: RawProduct[];
  coverage?: IngestResult["coverage"];
  discovered?: DetectedUrl[];
}

/**
 * A deliberately small brief for the research step. Research re-sends its whole context on every
 * tool round, so feeding it the full scrape (tens of thousands of tokens of page text) makes the
 * step slow and expensive without helping: the model is there to fill gaps, not to re-read what we
 * already parsed. It gets identities, what we hold, and precisely what is missing.
 */
export function summarizeForResearch(result: IngestResult, maxProducts = 60): string {
  const parts: string[] = [];
  const pasted = result.sources.filter((s) => !s.discovered);
  const found = result.sources.filter((s) => s.discovered);
  const line = (s: SourceSignals) => `- ${s.platform} ${s.kind}: ${s.url} [${s.status}${s.products.length ? `, ${s.products.length} products` : ""}${s.profile ? ", profile read" : ""}]`;
  parts.push(`## Merchant links\n${pasted.map(line).join("\n") || "- (none pasted)"}`);
  if (found.length) parts.push(`## Channels we discovered (verify they are the same merchant)\n${found.map(line).join("\n")}`);

  const identity = result.sources.map((s) => s.profile).filter(Boolean).map((p) => `name="${p!.name ?? ""}" handle=@${p!.handle ?? ""} followers=${p!.followers ?? "?"} bio="${(p!.bio ?? "").slice(0, 200)}" site=${p!.website ?? "-"}`);
  const fromShots = result.attachments.filter((a) => a.shopName || a.handle).map((a) => `screenshot: shop="${a.shopName ?? ""}" handle=@${a.handle ?? ""} ${a.location ?? ""}`);
  if (identity.length || fromShots.length) parts.push(`## Identity so far\n${[...identity, ...fromShots].join("\n")}`);

  const contacts = result.sources.flatMap((s) => [s.contacts.whatsapp && `whatsapp ${s.contacts.whatsapp}`, s.contacts.email && `email ${s.contacts.email}`, s.contacts.phone && `phone ${s.contacts.phone}`]).filter(Boolean);
  parts.push(`## Contacts found\n${contacts.length ? contacts.join("; ") : "none"}`);

  const priced = result.products.filter((p) => p.price != null && p.price > 0);
  parts.push(
    `## Products we already hold (${result.products.length}; ${priced.length} priced) — do not re-verify these, they are confirmed\n` +
      result.products
        .slice(0, maxProducts)
        .map((p) => `- ${p.title}${p.price != null ? ` | ${p.currency ?? ""} ${p.price}` : " | price unknown"}`)
        .join("\n") +
      (result.products.length > maxProducts ? `\n- …and ${result.products.length - maxProducts} more` : ""),
  );
  parts.push(`## Gaps to close (this is your job)\n${result.coverage.gaps.map((g) => `- ${g}`).join("\n") || "- none; confirm brand facts and contacts only"}`);
  if (result.texts.length) parts.push(`## Merchant pasted text\n${result.texts.join("\n").slice(0, 2000)}`);
  return parts.join("\n\n");
}

/** Compact, token-bounded summary of everything gathered, for prompts. */
export function summarizeSignalsForPrompt(material: PromptMaterial, maxProducts = 80): string {
  const parts: string[] = [];
  const { sources, texts } = material;
  if (material.coverage) {
    const c = material.coverage;
    parts.push(`### Coverage\n${c.totals.products} merged product candidates (${c.totals.withPrice} priced, ${c.totals.withImages} with photos); platforms: ${c.totals.platforms.join(", ") || "none"}; ${c.attachments.total} attachments.\nGaps: ${c.gaps.join(" ") || "none"}`);
  }
  if (material.products?.length) {
    const lines = [`### Merged product candidates (${material.products.length}; best evidence first)`];
    for (const p of material.products.slice(0, maxProducts)) {
      const price = p.price != null ? `${p.currency ?? ""} ${p.price}`.trim() : p.priceText ?? "price unknown";
      lines.push(`- ${p.title} | ${price}${p.compareAtPrice ? ` (was ${p.compareAtPrice})` : ""}${p.soldCount ? ` | sold ${p.soldCount}` : ""}${p.rating ? ` | rating ${p.rating}` : ""} | via ${p.via}${p.url ? ` | ${p.url}` : ""}${p.externalId ? ` | id ${p.externalId}` : ""}`);
      if (p.description) lines.push(`  desc: ${p.description.slice(0, 400).replace(/\n+/g, " ")}`);
      if (p.images?.length) lines.push(`  images: ${p.images.slice(0, 6).join(" ")}`);
      if (p.options?.length) lines.push(`  options: ${p.options.map((o) => `${o.name}: ${o.values.join("/")}`).join("; ")}`);
      if (p.variants?.length) lines.push(`  variants: ${p.variants.slice(0, 20).map((v) => `${v.title}${v.price != null ? ` @${v.price}` : ""}`).join("; ")}`);
      if (p.notes?.length) lines.push(`  notes: ${p.notes.join("; ")}`);
    }
    parts.push(lines.join("\n"));
  }
  sources.forEach((s, i) => {
    const lines: string[] = [];
    lines.push(`### Source ${i + 1}: ${s.platform} ${s.kind} — ${s.url}${s.discovered ? ` (discovered via ${s.discoveredFrom ?? "merchant pages"})` : ""}`);
    lines.push(`status: ${s.status}; strategies: ${s.providers.join(", ") || "none"}${s.errors.length ? `; issues: ${s.errors.slice(0, 3).join(" | ")}` : ""}`);
    if (s.handle) lines.push(`handle: ${s.handle}`);
    if (s.region) lines.push(`region: ${s.region}`);
    if (s.title) lines.push(`title: ${s.title}`);
    if (s.siteName) lines.push(`site name: ${s.siteName}`);
    if (s.description) lines.push(`description: ${s.description}`);
    if (s.profile) lines.push(`profile: ${JSON.stringify(s.profile)}`);
    if (s.contacts.whatsapp || s.contacts.email || s.contacts.phone) lines.push(`contacts: ${JSON.stringify(s.contacts)}`);
    const ogKeys = Object.keys(s.openGraph).filter((k) => !/image|url|type|site_name|title|description/.test(k)).slice(0, 12);
    if (ogKeys.length) lines.push(`meta: ${ogKeys.map((k) => `${k}=${s.openGraph[k]}`).join("; ")}`);
    const shopStats = s.embedded.tiktokShop as Record<string, unknown> | undefined;
    if (shopStats && Object.keys(shopStats).length) lines.push(`shop stats (real, from TikTok Shop): ${Object.entries(shopStats).filter(([k, v]) => v != null && k !== "background").map(([k, v]) => `${k}=${v}`).join(", ")}`);
    const shopReviews = s.embedded.tiktokShopReviews as Array<{ author?: string | null; rating?: number | null; text?: string }> | undefined;
    if (shopReviews?.length) lines.push(`customer reviews (${shopReviews.length}, real):\n${shopReviews.slice(0, 6).map((r) => `  - ${r.rating ?? "?"}/5 ${r.author ? `by ${r.author}` : ""}: ${(r.text ?? "").slice(0, 200).replace(/\n+/g, " ")}`).join("\n")}`);
    const { tiktokShop: _stats, tiktokShopReviews: _reviews, ...otherEmbedded } = s.embedded;
    if (Object.keys(otherEmbedded).length) lines.push(`embedded: ${JSON.stringify(otherEmbedded).slice(0, 2000)}`);
    if (s.images.length) lines.push(`images (${s.images.length}): ${s.images.slice(0, 20).join("\n  ")}`);
    if (s.products.length && !material.products) {
      lines.push(`products found (${s.products.length}):`);
      for (const p of s.products.slice(0, maxProducts)) {
        const price = p.price != null ? `${p.currency ?? ""} ${p.price}`.trim() : p.priceText ?? "price unknown";
        lines.push(`- ${p.title} | ${price}${p.url ? ` | ${p.url}` : ""}`);
      }
    } else if (s.products.length) lines.push(`products on this source: ${s.products.length} (merged above)`);
    const social = s.links.filter((l) => /instagram\.com|tiktok\.com|facebook\.com|shopee\.|lazada\.|wa\.me|whatsapp\.com|t\.me|youtube\.com|linktr\.ee|beacons\.ai|bio\.site|lynk\.id/i.test(l)).slice(0, 15);
    if (social.length) lines.push(`social links on page: ${social.join(" ")}`);
    const body = s.markdown && s.markdown.length > s.text.length ? s.markdown : s.text;
    if (body) lines.push(`page content:\n${body.slice(0, 3000)}`);
    parts.push(lines.join("\n"));
  });
  if (material.attachments?.length) {
    const lines = [`### Attachments (${material.attachments.length})`];
    for (const a of material.attachments) {
      lines.push(`- ${a.name} [${a.kind}, ${a.via}] platform=${a.platformGuess} page=${a.pageType} confidence=${a.confidence}${a.shopName ? ` shop=${a.shopName}` : ""}${a.handle ? ` handle=@${a.handle}` : ""}${a.followers ? ` followers=${a.followers}` : ""}${a.location ? ` location=${a.location}` : ""}`);
      if (a.bio) lines.push(`  bio: ${a.bio.slice(0, 300)}`);
      const c = a.contacts;
      if (c.whatsapp || c.email || c.phone || c.website) lines.push(`  contacts: ${JSON.stringify(c)}`);
      if (a.socialHandles.length) lines.push(`  handles: ${a.socialHandles.map((h) => `${h.platform}:@${h.handle}`).join(", ")}`);
      if (a.products.length) lines.push(`  products: ${a.products.length} (merged above)`);
      if (a.visibleText) lines.push(`  text: ${a.visibleText.slice(0, 600)}`);
      if (a.notes) lines.push(`  notes: ${a.notes}`);
    }
    parts.push(lines.join("\n"));
  }
  if (texts.length) parts.push(`### Merchant pasted text\n${texts.join("\n").slice(0, 6000)}`);
  return parts.join("\n\n");
}
