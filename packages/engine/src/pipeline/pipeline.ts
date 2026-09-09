/**
 * The Nexova pipeline, run in one process (local server, CLI, tests).
 *
 *   detect -> ingest -> discover -> attachments -> research -> normalize -> assets -> enrich
 *          -> template -> compose -> build -> deploy
 *
 * Each stage lives in stages.ts, reads its inputs from job artifacts and writes its outputs back,
 * so the same stages also run as durable Workflow steps on Vercel. Steps never call the Anthropic
 * SDK directly - only through ClaudeGateway.
 */
import type { EngineConfig } from "../config.js";
import type { ClaudeGateway } from "../claude/gateway.js";
import type { UsageLedger } from "../claude/usage.js";
import type { Deployer } from "../generate/deploy/types.js";
import type { JobEvent, JobRecord } from "../schema/job.js";
import type { Storage } from "../storage/types.js";
import type { StoreRepository } from "../store/repository.js";
import type { TemplateRegistry } from "../templates/registry.js";
import { addLogSink, createLogger } from "../util/log.js";
import type { JobBus } from "./events.js";
import type { JobStore } from "./job-store.js";
import { failJob, finishJob, runStep, setStatus, skipStep, stageAssets, stageAttachments, stageBuild, stageCompose, stageDeploy, stageDetect, stageDiscover, stageEnrich, stageIngest, stageNormalize, stagePreview, stageResearch, stageTemplate, type StageContext } from "./stages.js";
import { siteDirFor } from "../generate/compose.js";

export interface PipelineDeps {
  config: EngineConfig;
  gateway: ClaudeGateway;
  ledger: UsageLedger;
  registry: TemplateRegistry;
  jobs: JobStore;
  stores: StoreRepository;
  bus: JobBus;
  deployer: Deployer;
  storage: Storage;
}

/**
 * Build a stage context for a job: a logger whose records become job events and log lines, and a
 * ledger listener that keeps job.usage current. `publish` defaults to the in-process bus; the
 * Workflow runner passes a function that writes to the run's stream instead.
 */
export function createStageContext(job: JobRecord, deps: PipelineDeps, signal: AbortSignal, publish: (e: JobEvent) => void = (e) => deps.bus.publish(e)): { ctx: StageContext; detach: () => void } {
  const log = createLogger(`job:${job.id.slice(-6)}`);
  const stopSink = addLogSink((rec) => {
    if (!rec.ns.startsWith(log.ns) && !rec.ns.startsWith("claude") && !rec.ns.startsWith("templates")) return;
    publish({ type: "log", jobId: job.id, record: rec, at: rec.ts });
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
    publish({ type: "usage", jobId: job.id, usage: job.usage, at: new Date().toISOString() });
  });
  const ctx: StageContext = { deps, job, log, signal, publish };
  return { ctx, detach: () => (stopSink(), stopLedger()) };
}

export async function runJob(jobId: string, deps: PipelineDeps, signal: AbortSignal): Promise<JobRecord> {
  const job = await deps.jobs.get(jobId);
  if (!job) throw new Error(`job ${jobId} not found`);
  const { ctx, detach } = createStageContext(job, deps, signal);
  try {
    await setStatus(ctx, "running");
    await runStep(ctx, "detect", () => stageDetect(ctx));
    await runStep(ctx, "ingest", () => stageIngest(ctx));
    await runStep(ctx, "discover", () => stageDiscover(ctx));
    await runStep(ctx, "attachments", () => stageAttachments(ctx));
    await runStep(ctx, "research", () => stageResearch(ctx));
    await runStep(ctx, "normalize", () => stageNormalize(ctx));
    await runStep(ctx, "assets", () => stageAssets(ctx));
    await runStep(ctx, "preview", () => stagePreview(ctx));
    await runStep(ctx, "enrich", () => stageEnrich(ctx));
    await runStep(ctx, "template", () => stageTemplate(ctx));
    await runStep(ctx, "compose", () => stageCompose(ctx));
    await runStep(ctx, "build", () => stageBuild(ctx));
    await runStep(ctx, "deploy", () => stageDeploy(ctx));
    return await finishJob(ctx);
  } catch (err) {
    return await failJob(ctx, err);
  } finally {
    detach();
  }
}

/** Rebuild an existing store from its saved spec (after CMS edits or to switch template). No Claude calls. */
export async function runRebuild(jobId: string, slug: string, deps: PipelineDeps, signal: AbortSignal): Promise<JobRecord> {
  const job = await deps.jobs.get(jobId);
  if (!job) throw new Error(`job ${jobId} not found`);
  job.slug = slug;
  const { ctx, detach } = createStageContext(job, deps, signal);
  try {
    await setStatus(ctx, "running");
    for (const name of ["detect", "ingest", "discover", "attachments", "research", "normalize", "assets", "preview", "enrich"] as const) await skipStep(ctx, name, "rebuild");
    await runStep(ctx, "template", () => stageTemplate(ctx, "store"));
    await runStep(ctx, "compose", () => stageCompose(ctx));
    await runStep(ctx, "build", () => stageBuild(ctx));
    await runStep(ctx, "deploy", () => stageDeploy(ctx));
    return await finishJob(ctx);
  } catch (err) {
    return await failJob(ctx, err);
  } finally {
    detach();
  }
}

export { siteDirFor };
