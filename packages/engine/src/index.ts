/**
 * @nexova/engine public API.
 *
 *   const engine = await Engine.create();
 *   const job = await engine.createStore("https://www.tiktok.com/@somebrand\nhttps://shopee.com.my/somebrand");
 *   engine.subscribe(job.id, (e) => console.log(e));
 */
import { AnthropicGateway } from "./claude/anthropic-gateway.js";
import type { IncomingFile } from "./ingest/attachments.js";
import type { ClaudeGateway } from "./claude/gateway.js";
import { OfflineGateway } from "./claude/offline-gateway.js";
import { UsageLedger } from "./claude/usage.js";
import { loadConfig, type EngineConfig } from "./config.js";
import { LocalDeployer } from "./generate/deploy/local.js";
import { NetlifyDeployer } from "./generate/deploy/netlify.js";
import { VercelDeployer } from "./generate/deploy/vercel.js";
import { createStorage } from "./storage/index.js";
import type { Storage } from "./storage/types.js";
import type { Deployer } from "./generate/deploy/types.js";
import { JobBus } from "./pipeline/events.js";
import { JobStore } from "./pipeline/job-store.js";
import { runJob, runRebuild, type PipelineDeps } from "./pipeline/pipeline.js";
import type { JobEvent, JobOptions, JobRecord } from "./schema/job.js";
import { StoreRepository } from "./store/repository.js";
import { TemplateRegistry } from "./templates/registry.js";
import { ensureDir } from "./util/fsx.js";
import { createLogger } from "./util/log.js";

export interface EngineOptions {
  config?: Partial<EngineConfig>;
  gateway?: ClaudeGateway;
  deployer?: Deployer;
  env?: NodeJS.ProcessEnv;
  rootDir?: string;
}

export class Engine {
  readonly config: EngineConfig;
  readonly storage: Storage;
  readonly ledger: UsageLedger;
  readonly registry: TemplateRegistry;
  readonly jobs: JobStore;
  readonly stores: StoreRepository;
  readonly bus: JobBus;
  readonly gateway: ClaudeGateway;
  readonly deployer: Deployer;
  private readonly running = new Map<string, { promise: Promise<JobRecord>; abort: AbortController }>();
  private readonly log = createLogger("engine");

  private constructor(opts: EngineOptions) {
    this.config = { ...loadConfig(opts.env ?? process.env, opts.rootDir ?? process.cwd()), ...(opts.config ?? {}) };
    this.storage = createStorage(this.config);
    this.ledger = new UsageLedger(this.config, this.storage);
    this.registry = new TemplateRegistry(this.config);
    this.jobs = new JobStore(this.config, this.storage);
    this.stores = new StoreRepository(this.config, this.storage);
    this.bus = new JobBus();
    this.gateway = opts.gateway ?? (this.config.offline ? new OfflineGateway() : new AnthropicGateway(this.config, this.ledger));
    this.deployer = opts.deployer ?? (this.config.deployTarget === "netlify" && this.config.netlifyToken ? new NetlifyDeployer(this.config) : this.config.deployTarget === "vercel" && this.config.vercelToken ? new VercelDeployer(this.config) : new LocalDeployer(this.config));
  }

  static async create(opts: EngineOptions = {}): Promise<Engine> {
    const engine = new Engine(opts);
    await engine.init();
    return engine;
  }

  private async init(): Promise<void> {
    await ensureDir(this.config.storesDir);
    await ensureDir(this.config.dataDir);
    await this.storage.init();
    const templates = await this.registry.list();
    this.log.info(`engine ready`, { model: this.config.model, effort: this.config.effort, gateway: this.gateway.id, deployer: this.deployer.id, storage: this.storage.id, templates: templates.map((t) => t.manifest.id) });
    if (this.config.offline) this.log.warn("running OFFLINE: no ANTHROPIC_API_KEY found, using heuristic gateway (lower quality). Set the key in .env to enable Claude.");
  }

  private deps(): PipelineDeps {
    return { config: this.config, gateway: this.gateway, ledger: this.ledger, registry: this.registry, jobs: this.jobs, stores: this.stores, bus: this.bus, deployer: this.deployer, storage: this.storage };
  }

  /** Create a job and start it in the background. Subscribe to events or await waitFor(). */
  async createStore(raw: string, options: JobOptions = {}, files: IncomingFile[] = []): Promise<JobRecord> {
    const job = await this.jobs.create(raw, options, files);
    const abort = new AbortController();
    const promise = runJob(job.id, this.deps(), abort.signal).finally(() => this.running.delete(job.id));
    this.running.set(job.id, { promise, abort });
    return job;
  }

  /** Rebuild a store from its saved spec (after edits, or to switch template). */
  async rebuildStore(slug: string, options: JobOptions = {}): Promise<JobRecord> {
    const job = await this.jobs.create(`rebuild:${slug}`, { ...options, slug });
    const abort = new AbortController();
    const promise = runRebuild(job.id, slug, this.deps(), abort.signal).finally(() => this.running.delete(job.id));
    this.running.set(job.id, { promise, abort });
    return job;
  }

  async waitFor(jobId: string): Promise<JobRecord> {
    const r = this.running.get(jobId);
    if (r) return r.promise;
    const job = await this.jobs.get(jobId);
    if (!job) throw new Error(`job ${jobId} not found`);
    return job;
  }

  cancel(jobId: string): boolean {
    const r = this.running.get(jobId);
    if (!r) return false;
    r.abort.abort(new Error("cancelled by user"));
    return true;
  }

  isRunning(jobId: string): boolean {
    return this.running.has(jobId);
  }

  subscribe(jobId: string | "*", fn: (event: JobEvent) => void): () => void {
    return this.bus.subscribe(jobId, fn);
  }

  getJob(jobId: string): Promise<JobRecord | null> {
    return this.jobs.get(jobId);
  }

  listJobs(limit = 50): Promise<JobRecord[]> {
    return this.jobs.list(limit);
  }

  usage(filter: { jobId?: string; since?: Date } = {}) {
    return this.ledger.report(filter);
  }

  /** Verify credentials and model access with a cheap round-trip. Throws when unavailable. */
  checkModelAccess(signal?: AbortSignal) {
    return this.gateway.ping({ jobId: null, signal });
  }

  /** Compile every structured-output schema against the API before a job depends on it. */
  checkSchemas(signal?: AbortSignal) {
    return this.gateway.validateSchemas({ jobId: null, signal });
  }

  templates() {
    return this.registry.list(true);
  }
}

export { loadConfig } from "./config.js";
export type { EngineConfig, Effort } from "./config.js";
export * from "./schema/store-spec.js";
export * from "./schema/job.js";
export * from "./schema/manifest.js";
export type * from "./schema/signals.js";
export type * from "./schema/drafts.js";
export { detectInput, classifyUrl, platformLabel, CURRENCY_BY_REGION } from "./ingest/detect.js";
export { ingest, ingestUrls, runDiscovery, processAttachments, assemble, summarizeSignalsForPrompt, defaultProviders } from "./ingest/ingest.js";
export type { Provider, ProviderContext } from "./ingest/providers/types.js";
export { discoverSources, candidatesFromLinks, handleMatches, isBioLinkHost } from "./ingest/discover.js";
export { mergeProducts, sanityCheck, titleSimilarity } from "./ingest/merge.js";
export { buildCoverage, coverageSummary } from "./ingest/coverage.js";
export { parseCsv, productsFromTable, productsFromJsonFile, saveAttachments, kindFor } from "./ingest/attachments.js";
export type { IncomingFile } from "./ingest/attachments.js";
export { huntProducts, huntProductsInHtml, extractJsonBlobs } from "./ingest/parsers/hunter.js";
export { productsFromMarkdown } from "./ingest/providers/reader.js";
export { tiktokShopApiProvider, makeTikTokShopApiProvider, mapListProduct, mapProductDetail, TIKTOK_SHOP_REGIONS } from "./ingest/providers/tiktok-shop-api.js";
export { fetchPage, fetchPageLadder, fetchJson } from "./ingest/http.js";
export type { ClaudeGateway, GatewayContext } from "./claude/gateway.js";
export { NexovaError } from "./claude/gateway.js";
export { AnthropicGateway } from "./claude/anthropic-gateway.js";
export { OfflineGateway, chooseTemplateByRules } from "./claude/offline-gateway.js";
export { UsageLedger } from "./claude/usage.js";
export type { LedgerEntry, UsageReport } from "./claude/usage.js";
export { buildSpec, applyEnrichment, rawProductsFromTexts, evidenceFromSignals, reviewerDisplayName } from "./claude/mapping.js";
export { TemplateRegistry } from "./templates/registry.js";
export { StoreRepository } from "./store/repository.js";
export type { StoreMeta } from "./store/repository.js";
export { composeSite, themeCss, siteDirFor, assetsDirFor } from "./generate/compose.js";
export { buildSite } from "./generate/build.js";
export { LocalDeployer, liveDirFor, localStoreUrl } from "./generate/deploy/local.js";
export { NetlifyDeployer } from "./generate/deploy/netlify.js";
export { VercelDeployer } from "./generate/deploy/vercel.js";
export { createStorage, FsStorage, VercelStorage } from "./storage/index.js";
export type { Storage } from "./storage/types.js";
export { readRef } from "./util/refs.js";
export type { Deployer, DeployInput, DeployResult } from "./generate/deploy/types.js";
export { JobBus } from "./pipeline/events.js";
export { JobStore } from "./pipeline/job-store.js";
export { loadDotEnv } from "./util/env.js";
export { createLogger, addLogSink, setLogLevel } from "./util/log.js";
export type { Logger, LogRecord } from "./util/log.js";
