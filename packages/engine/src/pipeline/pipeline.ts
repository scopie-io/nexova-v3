/**
 * The Nexova pipeline. Each step is idempotent and persists its output as a job artifact,
 * so a failed job can be resumed from the last good step and every intermediate can be
 * inspected. Steps never call the Anthropic SDK directly - only through ClaudeGateway.
 *
 *   detect -> ingest -> discover -> attachments -> research -> normalize -> assets -> enrich
 *          -> template -> compose -> build -> deploy
 */
import path from "node:path";
import type { EngineConfig } from "../config.js";
import type { ClaudeGateway, GatewayContext } from "../claude/gateway.js";
import { applyEnrichment, buildSpec } from "../claude/mapping.js";
import { chooseTemplateByRules } from "../claude/offline-gateway.js";
import type { UsageLedger } from "../claude/usage.js";
import { CURRENCY_BY_REGION, LOCALE_BY_REGION, detectInput } from "../ingest/detect.js";
import { assemble, captureAttachments, ingestUrls, processAttachments, runDiscovery } from "../ingest/ingest.js";
import { coverageSummary } from "../ingest/coverage.js";
import { localizeAssets } from "../generate/assets.js";
import { buildSite } from "../generate/build.js";
import { assetsDirFor, composeSite, siteDirFor } from "../generate/compose.js";
import type { Deployer } from "../generate/deploy/types.js";
import type { StoreDraft, ProductDraft } from "../schema/drafts.js";
import type { JobRecord, StepName, StepState } from "../schema/job.js";
import type { TemplateEntry } from "../schema/manifest.js";
import type { AttachmentExtract, DetectedUrl, IngestInput, IngestResult, RawProduct, ResearchFindings, SourceSignals } from "../schema/signals.js";
import { parseStoreSpec, type SourceRecord, type StoreSpec } from "../schema/store-spec.js";
import type { StoreRepository } from "../store/repository.js";
import type { TemplateRegistry } from "../templates/registry.js";
import { addLogSink, createLogger, errorMessage, type Logger } from "../util/log.js";
import { NexovaError } from "../claude/gateway.js";
import { withTimeout } from "../util/retry.js";
import type { JobBus } from "./events.js";
import type { JobStore } from "./job-store.js";

export interface PipelineDeps {
  config: EngineConfig;
  gateway: ClaudeGateway;
  ledger: UsageLedger;
  registry: TemplateRegistry;
  jobs: JobStore;
  stores: StoreRepository;
  bus: JobBus;
  deployer: Deployer;
}

/** Products per normalization call. Kept modest so one batch's JSON stays inside the output budget. */
const PRODUCT_BATCH = 12;

class StepFailure extends Error {
  constructor(
    public readonly step: StepName,
    message: string,
  ) {
    super(message);
    this.name = "StepFailure";
  }
}

export async function runJob(jobId: string, deps: PipelineDeps, signal: AbortSignal): Promise<JobRecord> {
  const job = await deps.jobs.get(jobId);
  if (!job) throw new Error(`job ${jobId} not found`);
  const log = createLogger(`job:${job.id.slice(-6)}`);
  const stopSink = addLogSink((rec) => {
    if (!rec.ns.startsWith(log.ns) && !rec.ns.startsWith("claude") && !rec.ns.startsWith("templates")) return;
    deps.bus.publish({ type: "log", jobId: job.id, record: rec, at: rec.ts });
    void deps.jobs.appendLog(job, `${rec.ts} ${rec.level} [${rec.ns}] ${rec.msg}${rec.data ? " " + JSON.stringify(rec.data) : ""}`);
  });
  const stopLedger = deps.ledger.onEntry((e) => {
    if (e.jobId !== job.id) return;
    job.usage.calls += 1;
    job.usage.inputTokens += e.inputTokens;
    job.usage.outputTokens += e.outputTokens;
    job.usage.cacheReadTokens += e.cacheReadTokens;
    job.usage.cacheWriteTokens += e.cacheWriteTokens;
    job.usage.webSearches += e.webSearches;
    job.usage.webFetches += e.webFetches;
    job.usage.costUsd = Math.round((job.usage.costUsd + e.costUsd) * 1_000_000) / 1_000_000;
    deps.bus.publish({ type: "usage", jobId: job.id, usage: job.usage, at: new Date().toISOString() });
  });

  const ctx = new StepContext(job, deps, log, signal);
  const ingestOpts = () => ({ config: deps.config, log: log.child("ingest"), signal, captureDir: deps.jobs.captureDir(job.id), jobId: job.id });
  try {
    await ctx.setStatus("running");
    const state: PipelineState = { sources: [], discovered: [], attachmentExtracts: [] };

    await ctx.step("detect", async () => {
      const det = detectInput(job.input.raw);
      const input: IngestInput = { ...det, attachments: job.input.attachments ?? [] };
      if (input.urls.length === 0 && input.texts.length === 0 && input.attachments.length === 0) throw new StepFailure("detect", "Paste at least one link (TikTok, Instagram, Shopee, Facebook, Lazada, Shopify or a website), a product list, or attach screenshots.");
      state.input = input;
      await deps.jobs.putArtifact(job, "input", input);
      return `${input.urls.length} link(s): ${input.urls.map((u) => `${u.platform}/${u.kind}`).join(", ") || "none"}${input.texts.length ? `; ${input.texts.length} text line(s)` : ""}${input.attachments.length ? `; ${input.attachments.length} attachment(s)` : ""}`;
    });

    await ctx.step("ingest", async () => {
      if (!state.input!.urls.length) return ctx.skip("no links pasted");
      const sources = await ingestUrls(state.input!.urls, { ...ingestOpts(), onProgress: (m) => ctx.progress("ingest", m), onSource: (s) => ctx.progress("ingest", `${s.platform} ${s.kind}: ${s.status}${s.products.length ? `, ${s.products.length} products` : ""}${s.profile ? ", profile found" : ""}`) });
      state.sources = sources;
      const ok = sources.filter((s) => s.status === "ok" || s.status === "partial").length;
      const products = sources.reduce((n, s) => n + s.products.length, 0);
      const strategies = [...new Set(sources.flatMap((s) => s.providers))];
      return `${ok}/${sources.length} sources readable, ${products} raw products, ${sources.filter((s) => s.profile).length} profiles via ${strategies.join(", ") || "nothing"}`;
    });

    await ctx.step("discover", async () => {
      if (job.input.options.skipDiscovery || !deps.config.discovery) return ctx.skip("discovery disabled");
      if (!state.sources.length) return ctx.skip("nothing to expand from");
      const { result, newSources } = await runDiscovery(state.sources, state.input!, { ...ingestOpts(), onProgress: (m) => ctx.progress("discover", m) });
      state.discovered = result.candidates;
      state.sources = [...state.sources, ...newSources];
      await deps.jobs.putArtifact(job, "discovery", { ...result, newSources: newSources.map((s) => ({ url: s.url, status: s.status, products: s.products.length })) });
      if (!result.candidates.length) return ctx.skip(`no extra channels found${result.bioPagesFetched.length ? ` (checked ${result.bioPagesFetched.length} bio page)` : ""}`);
      const readable = newSources.filter((s) => s.status === "ok" || s.status === "partial");
      return `${result.candidates.length} extra channel(s): ${result.candidates.map((c) => `${c.platform}/${c.kind}`).join(", ")}; ${readable.length} readable, +${newSources.reduce((n, s) => n + s.products.length, 0)} products`;
    });

    await ctx.step("attachments", async () => {
      const uploads = state.input!.attachments;
      const captures = captureAttachments(state.sources);
      const all = [...uploads, ...captures];
      const vision = deps.config.offline ? undefined : (images: typeof all) => deps.gateway.extractFromAttachments({ images, context: `Pasted links: ${state.input!.urls.map((u) => `${u.platform} ${u.kind} ${u.url}`).join("; ") || "none"}. Known shop names/handles: ${[...new Set(state.sources.flatMap((s) => [s.profile?.name, s.profile?.handle, s.handle]).filter(Boolean))].join(", ") || "unknown"}.` }, ctx.gatewayCtx("attachments"));
      const extracts = all.length ? await processAttachments(all, { ...ingestOpts(), onProgress: (m) => ctx.progress("attachments", m) }, vision) : [];
      state.attachmentExtracts = extracts;
      const region = state.sources.map((s) => s.region).find(Boolean) ?? null;
      const currencyHint = job.input.options.currency?.toUpperCase() || (region ? CURRENCY_BY_REGION[region] ?? null : null);
      state.ingest = assemble(state.sources, state.input!.texts, extracts, state.discovered, currencyHint);
      await deps.jobs.putArtifact(job, "ingest", state.ingest);
      await deps.jobs.putArtifact(job, "coverage", state.ingest.coverage);
      const imgCount = all.filter((a) => a.kind === "image").length;
      const attNote = all.length ? `${uploads.length} upload(s)${captures.length ? ` + ${captures.length} capture(s)` : ""}: ${extracts.reduce((n, a) => n + a.products.length, 0)} products read${deps.config.offline && imgCount ? ` (${imgCount} image(s) need Claude)` : ""}` : "no attachments";
      return `${attNote}. ${coverageSummary(state.ingest.coverage)}`;
    });

    await ctx.step("research", async () => {
      if (job.input.options.skipResearch) return ctx.skip("skipped by request");
      if (deps.config.offline) return ctx.skip("offline mode (no ANTHROPIC_API_KEY)");
      const gctx = ctx.gatewayCtx("research");
      // Research enriches the store, it does not gate it. A timeout, a refusal or a provider
      // outage degrades this step to "skipped" instead of costing the merchant their build.
      let findings: ResearchFindings;
      try {
        findings = await withTimeout(deps.gateway.research({ ingest: state.ingest!, instructions: job.input.options.instructions ?? null }, gctx), deps.config.researchTimeoutMs, "research");
      } catch (err) {
        const reason = errorMessage(err);
        log.warn(`research unavailable, continuing without it: ${reason}`);
        state.ingest!.coverage.gaps.push(`Web research did not complete (${reason.slice(0, 120)}), so gaps were not filled from the web.`);
        return ctx.skip(`unavailable: ${reason.slice(0, 120)}`);
      }
      state.research = findings;
      await deps.jobs.putArtifact(job, "research.md", findings.markdown || "(empty)");
      await deps.jobs.putArtifact(job, "research", { ...findings, markdown: undefined });
      if (findings.skipped) return ctx.skip("research returned nothing");
      return `${findings.searches} searches, ${findings.fetches} page reads, ${findings.citations.length} sources, ${Math.round(findings.markdown.length / 4)} tokens of notes`;
    });

    await ctx.step("normalize", async () => {
      const research = state.research ?? { markdown: "", citations: [], searches: 0, fetches: 0, skipped: true };
      const ing = state.ingest!;
      const region = ing.sources.map((s) => s.region).find(Boolean) ?? null;
      const currencyHint = job.input.options.currency?.toUpperCase() || (region ? CURRENCY_BY_REGION[region] ?? null : null) || ing.products.map((p) => p.currency).find(Boolean) || null;
      const localeHint = region ? LOCALE_BY_REGION[region] ?? null : null;
      const gctx = ctx.gatewayCtx("normalize");

      const store = await deps.gateway.normalizeStore({ ingest: ing, research, instructions: job.input.options.instructions ?? null, currencyHint, localeHint }, gctx);
      await deps.jobs.putArtifact(job, "store.draft", store);

      const raw: RawProduct[] = ing.products;
      const batches: RawProduct[][] = [];
      for (let i = 0; i < raw.length; i += PRODUCT_BATCH) batches.push(raw.slice(i, i + PRODUCT_BATCH));
      if (batches.length === 0) batches.push([]);
      const products: ProductDraft[] = [];
      const remaining = () => Math.max(0, deps.config.maxProducts - products.length);
      for (let b = 0; b < batches.length && remaining() > 0; b++) {
        const drafts = await deps.gateway.normalizeProducts({ rawProducts: batches[b], ingest: ing, research, store, batchIndex: b, batchCount: batches.length, maxProducts: Math.min(remaining(), PRODUCT_BATCH + 10) }, gctx);
        products.push(...drafts);
      }
      await deps.jobs.putArtifact(job, "products.draft", products);

      const slug = job.slug ?? (await deps.stores.reserveSlug(job.input.options.slug ?? null, store.brand.name));
      job.slug = slug;
      const sources: SourceRecord[] = ing.sources.map((s) => ({ url: s.url, platform: s.platform, kind: s.kind, handle: s.handle, fetchedAt: s.fetchedAt, status: s.status, providers: s.providers, notes: [s.discovered ? "discovered" : "", ...s.errors.slice(0, 2)].filter(Boolean).join(" | ") }));
      const spec = buildSpec(store, products, { id: job.id, slug, engineVersion: deps.config.engineVersion, currencyOverride: job.input.options.currency?.toUpperCase() ?? null, sources, maxProducts: deps.config.maxProducts });
      if (spec.catalog.products.length === 0) spec.meta.warnings.push("No products could be extracted. The store is live with an empty catalog; add products in the inventory editor.");
      for (const gap of ing.coverage.gaps.slice(0, 4)) if (!spec.meta.warnings.includes(gap)) spec.meta.warnings.push(gap);
      state.spec = spec;
      state.store = store;
      await deps.jobs.putArtifact(job, "spec.draft", spec);
      return `${spec.brand.name}: ${spec.catalog.products.length} products, ${spec.catalog.categories.length} categories, currency ${spec.commerce.currency}`;
    });

    await ctx.step("assets", async () => {
      const referer = state.ingest?.sources[0]?.url ?? null;
      const result = await localizeAssets(state.spec!, assetsDirFor(deps.config, job.slug!), { log: log.child("assets"), signal, referer });
      state.spec = result.spec;
      state.imagePaths = result.representative;
      return `${result.downloaded} images downloaded, ${result.skipped} reused, ${result.failed} failed`;
    });

    await ctx.step("enrich", async () => {
      const manifests = await deps.registry.manifests();
      const gctx = ctx.gatewayCtx("enrich");
      const enrichment = await deps.gateway.enrich({ spec: state.spec!, templates: manifests, imagePaths: state.imagePaths ?? [], instructions: job.input.options.instructions ?? null }, gctx);
      await deps.jobs.putArtifact(job, "enrichment", enrichment);
      state.spec = applyEnrichment(state.spec!, enrichment, manifests.map((m) => m.id));
      await deps.jobs.putArtifact(job, "spec", state.spec);
      return `theme ${state.spec.theme.preset}/${state.spec.theme.mode}, ${state.spec.pages.home.featuredProductIds.length} featured, template suggestion: ${state.spec.template.id ?? "none"}`;
    });

    await ctx.step("template", async () => {
      const entries = await deps.registry.list(true);
      if (entries.length === 0) throw new StepFailure("template", `No templates found in ${deps.config.templatesDir}. Add at least one folder with nexova.template.json.`);
      const wanted = job.input.options.templateId ?? state.spec!.template.id ?? null;
      let entry = wanted ? entries.find((e) => e.manifest.id === wanted) ?? null : null;
      let reason = state.spec!.template.reason;
      if (!entry) {
        const chosen = chooseTemplateByRules(entries.map((e) => e.manifest), state.spec!);
        entry = entries.find((e) => e.manifest.id === chosen?.id) ?? entries[0];
        reason = wanted ? `requested template "${wanted}" not found; picked ${entry.manifest.id} by rules` : `picked by rules`;
      }
      state.template = entry;
      state.spec!.template = { id: entry.manifest.id, reason };
      job.templateId = entry.manifest.id;
      await deps.jobs.putArtifact(job, "spec", state.spec);
      return `${entry.manifest.name} (${entry.manifest.id}) — ${reason}`;
    });

    await ctx.step("compose", async () => {
      const basePath = `/s/${job.slug}/`;
      const spec = parseStoreSpec(state.spec!);
      await deps.stores.saveSpec(spec);
      await deps.stores.updateMeta(spec.slug, { jobId: job.id, templateId: state.template!.manifest.id });
      const result = await composeSite({ spec, template: state.template!, config: deps.config, log: log.child("compose"), basePath });
      state.siteDir = result.siteDir;
      state.basePath = basePath;
      return `${result.filesCopied} files at ${path.relative(deps.config.rootDir, result.siteDir)}`;
    });

    await ctx.step("build", async () => {
      if (job.input.options.skipBuild) return ctx.skip("skipped by request");
      await deps.registry.ensureInstalled(state.template!, log.child("install"), signal);
      const result = await buildSite({ siteDir: state.siteDir!, template: state.template!, basePath: state.basePath!, slug: job.slug!, log: log.child("build"), signal, onLine: (line) => ctx.progress("build", line.slice(0, 160)) });
      state.distDir = result.outDir;
      return `built in ${Math.round(result.durationMs / 1000)}s`;
    });

    await ctx.step("deploy", async () => {
      if (job.input.options.skipBuild || !state.distDir) return ctx.skip("nothing to deploy");
      const result = await deps.deployer.deploy({ slug: job.slug!, distDir: state.distDir, spec: state.spec!, log: log.child("deploy"), signal });
      job.siteUrl = result.url;
      await deps.stores.updateMeta(job.slug!, { siteUrl: result.url, builtAt: new Date().toISOString(), deployProvider: result.provider });
      return `live at ${result.url}`;
    });

    job.status = "done";
    job.error = null;
    await deps.jobs.save(job);
    deps.bus.publish({ type: "status", jobId: job.id, status: "done", at: new Date().toISOString() });
    deps.bus.publish({ type: "done", jobId: job.id, job, at: new Date().toISOString() });
    log.info(`job done${job.siteUrl ? `: ${job.siteUrl}` : ""}`, { costUsd: job.usage.costUsd });
    return job;
  } catch (err) {
    const message = errorMessage(err);
    job.status = signal.aborted ? "cancelled" : "failed";
    job.error = message;
    await deps.jobs.save(job);
    deps.bus.publish({ type: "status", jobId: job.id, status: job.status, at: new Date().toISOString() });
    deps.bus.publish({ type: "error", jobId: job.id, error: message, at: new Date().toISOString() });
    log.error(`job ${job.status}: ${message}`);
    return job;
  } finally {
    stopSink();
    stopLedger();
  }
}

/** Rebuild an existing store from its saved spec (after CMS edits or to switch template). No Claude calls. */
export async function runRebuild(jobId: string, slug: string, deps: PipelineDeps, signal: AbortSignal): Promise<JobRecord> {
  const job = await deps.jobs.get(jobId);
  if (!job) throw new Error(`job ${jobId} not found`);
  const log = createLogger(`job:${job.id.slice(-6)}`);
  const stopSink = addLogSink((rec) => {
    if (!rec.ns.startsWith(log.ns) && !rec.ns.startsWith("templates")) return;
    deps.bus.publish({ type: "log", jobId: job.id, record: rec, at: rec.ts });
  });
  const ctx = new StepContext(job, deps, log, signal);
  try {
    await ctx.setStatus("running");
    for (const name of ["detect", "ingest", "discover", "attachments", "research", "normalize", "assets", "enrich"] as StepName[]) await ctx.step(name, async () => ctx.skip("rebuild"));
    const state: PipelineState = { sources: [], discovered: [], attachmentExtracts: [] };
    await ctx.step("template", async () => {
      const spec = await deps.stores.getSpec(slug);
      if (!spec) throw new StepFailure("template", `store ${slug} not found`);
      job.slug = slug;
      const entries = await deps.registry.list(true);
      const wanted = job.input.options.templateId ?? spec.template.id;
      const entry = entries.find((e) => e.manifest.id === wanted) ?? entries[0];
      if (!entry) throw new StepFailure("template", "no templates installed");
      spec.template = { id: entry.manifest.id, reason: spec.template.reason || "rebuild" };
      state.spec = spec;
      state.template = entry;
      job.templateId = entry.manifest.id;
      return `${entry.manifest.id}`;
    });
    await ctx.step("compose", async () => {
      const basePath = `/s/${slug}/`;
      await deps.stores.saveSpec(state.spec!);
      const result = await composeSite({ spec: state.spec!, template: state.template!, config: deps.config, log: log.child("compose"), basePath });
      state.siteDir = result.siteDir;
      state.basePath = basePath;
      return `${result.filesCopied} files`;
    });
    await ctx.step("build", async () => {
      await deps.registry.ensureInstalled(state.template!, log.child("install"), signal);
      const result = await buildSite({ siteDir: state.siteDir!, template: state.template!, basePath: state.basePath!, slug, log: log.child("build"), signal });
      state.distDir = result.outDir;
      return `built in ${Math.round(result.durationMs / 1000)}s`;
    });
    await ctx.step("deploy", async () => {
      const result = await deps.deployer.deploy({ slug, distDir: state.distDir!, spec: state.spec!, log: log.child("deploy"), signal });
      job.siteUrl = result.url;
      await deps.stores.updateMeta(slug, { siteUrl: result.url, builtAt: new Date().toISOString(), deployProvider: result.provider, jobId: job.id, templateId: state.template!.manifest.id });
      return `live at ${result.url}`;
    });
    job.status = "done";
    await deps.jobs.save(job);
    deps.bus.publish({ type: "status", jobId: job.id, status: "done", at: new Date().toISOString() });
    deps.bus.publish({ type: "done", jobId: job.id, job, at: new Date().toISOString() });
    return job;
  } catch (err) {
    job.status = signal.aborted ? "cancelled" : "failed";
    job.error = errorMessage(err);
    await deps.jobs.save(job);
    deps.bus.publish({ type: "status", jobId: job.id, status: job.status, at: new Date().toISOString() });
    deps.bus.publish({ type: "error", jobId: job.id, error: job.error, at: new Date().toISOString() });
    return job;
  } finally {
    stopSink();
  }
}

interface PipelineState {
  input?: IngestInput;
  sources: SourceSignals[];
  discovered: DetectedUrl[];
  attachmentExtracts: AttachmentExtract[];
  ingest?: IngestResult;
  research?: ResearchFindings;
  store?: StoreDraft;
  spec?: StoreSpec;
  imagePaths?: string[];
  template?: TemplateEntry;
  siteDir?: string;
  basePath?: string;
  distDir?: string;
}

const SKIP = Symbol("skip");
type StepOutcome = string | typeof SKIP;

class StepContext {
  private skipMessage = "";
  constructor(
    private readonly job: JobRecord,
    private readonly deps: PipelineDeps,
    private readonly log: Logger,
    private readonly signal: AbortSignal,
  ) {}

  skip(message: string): typeof SKIP {
    this.skipMessage = message;
    return SKIP;
  }

  async setStatus(status: JobRecord["status"]): Promise<void> {
    this.job.status = status;
    await this.deps.jobs.save(this.job);
    this.deps.bus.publish({ type: "status", jobId: this.job.id, status, at: new Date().toISOString() });
  }

  progress(step: StepName, message: string): void {
    this.deps.bus.publish({ type: "progress", jobId: this.job.id, step, message, at: new Date().toISOString() });
  }

  gatewayCtx(step: StepName): GatewayContext {
    return { jobId: this.job.id, signal: this.signal, onProgress: (m) => this.progress(step, m) };
  }

  private stepState(name: StepName): StepState {
    return this.job.steps.find((s) => s.name === name)!;
  }

  async step(name: StepName, fn: () => Promise<StepOutcome>): Promise<void> {
    if (this.signal.aborted) throw new Error("cancelled");
    const st = this.stepState(name);
    st.status = "running";
    st.startedAt = new Date().toISOString();
    st.attempts += 1;
    st.error = null;
    await this.deps.jobs.save(this.job);
    this.deps.bus.publish({ type: "step", jobId: this.job.id, step: { ...st }, at: st.startedAt });
    this.log.info(`▶ ${name}`);
    // "research" is deliberately absent: it handles its own failure and must never be paid for twice.
    const maxAttempts = name === "normalize" || name === "enrich" || name === "attachments" ? 2 : 1;
    try {
      let outcome: StepOutcome | undefined;
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
          outcome = await fn();
          break;
        } catch (err) {
          const retryable = err instanceof NexovaError ? err.retryable : !(err instanceof StepFailure) && attempt < maxAttempts && !this.signal.aborted;
          if (!retryable || attempt >= maxAttempts) throw err;
          this.log.warn(`${name} attempt ${attempt} failed, retrying: ${errorMessage(err)}`);
          st.attempts += 1;
        }
      }
      st.endedAt = new Date().toISOString();
      if (outcome === SKIP) {
        st.status = "skipped";
        st.message = this.skipMessage;
        this.log.info(`↷ ${name} skipped: ${this.skipMessage}`);
      } else {
        st.status = "done";
        st.message = outcome ?? "";
        this.log.info(`✓ ${name}: ${st.message}`);
      }
    } catch (err) {
      st.status = "failed";
      st.endedAt = new Date().toISOString();
      st.error = errorMessage(err);
      st.message = st.error;
      await this.deps.jobs.save(this.job);
      this.deps.bus.publish({ type: "step", jobId: this.job.id, step: { ...st }, at: st.endedAt });
      throw new StepFailure(name, `${name}: ${st.error}`);
    }
    await this.deps.jobs.save(this.job);
    this.deps.bus.publish({ type: "step", jobId: this.job.id, step: { ...st }, at: st.endedAt! });
  }
}

export { siteDirFor };
