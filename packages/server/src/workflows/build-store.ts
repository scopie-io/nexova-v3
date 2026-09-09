/**
 * The Nexova pipeline as a durable Workflow (Vercel). Each pipeline stage is a step: its own
 * function invocation with full Node.js, retried by the runtime only where a re-run cannot cost
 * the merchant money (the engine's own retry rules inside runStep still apply).
 *
 * State lives in job artifacts (Neon) between steps, progress is streamed on the run's default
 * stream as JobEvent objects, and the job record is kept current so the web app sees the same
 * thing it does with the local server.
 */
import { getWritable } from "workflow";
import { createStageContext, stages, type Engine, type JobEvent, type StageContext, type StepOutcome } from "@nexova/engine";
import { getEngine } from "../engine.js";

type StepName = Parameters<typeof stages.runStep>[1];

/** Load the job, run one stage with bookkeeping, persist, and stream events. Used inside every step. */
async function runStage(jobId: string, name: StepName, stage: (ctx: StageContext) => Promise<StepOutcome>): Promise<void> {
  const engine = await getEngine();
  const job = await engine.jobs.get(jobId);
  if (!job) throw new Error(`job ${jobId} not found`);
  const { ctx, detach } = withStream(engine, job);
  try {
    if (job.status === "queued") await stages.setStatus(ctx, "running");
    await stages.runStep(ctx, name, () => stage(ctx));
  } finally {
    await detach();
  }
}

function withStream(engine: Engine, job: Parameters<typeof createStageContext>[0]): { ctx: StageContext; detach: () => Promise<void> } {
  const writer = getWritable<JobEvent>().getWriter();
  let pending: Promise<void> = Promise.resolve();
  const publish = (e: JobEvent) => {
    pending = pending.then(() => writer.write(e)).catch(() => undefined);
  };
  const { ctx, detach } = createStageContext(job, engine.deps(), new AbortController().signal, publish);
  return {
    ctx,
    detach: async () => {
      detach();
      await pending;
      writer.releaseLock();
    },
  };
}

// ---------- steps (one per invocation) ----------

async function stepDetect(jobId: string) {
  "use step";
  await runStage(jobId, "detect", stages.stageDetect);
}
stepDetect.maxRetries = 0;

async function stepIngest(jobId: string) {
  "use step";
  await runStage(jobId, "ingest", stages.stageIngest);
}
stepIngest.maxRetries = 0;

async function stepDiscover(jobId: string) {
  "use step";
  await runStage(jobId, "discover", stages.stageDiscover);
}
stepDiscover.maxRetries = 0;

async function stepAttachments(jobId: string) {
  "use step";
  await runStage(jobId, "attachments", stages.stageAttachments);
}
stepAttachments.maxRetries = 0;

async function stepResearch(jobId: string) {
  "use step";
  // Hard cap so the step fits one function invocation on every Vercel plan.
  await runStage(jobId, "research", (ctx) => stages.stageResearch(ctx, { timeoutMs: Math.min(ctx.deps.config.researchTimeoutMs, 240_000) }));
}
stepResearch.maxRetries = 0;

/** Normalize is one UI step spread over several invocations: store, then a batch of products each. */
async function stepNormalizeStore(jobId: string): Promise<number> {
  "use step";
  const engine = await getEngine();
  const job = await engine.jobs.get(jobId);
  if (!job) throw new Error(`job ${jobId} not found`);
  const { ctx, detach } = withStream(engine, job);
  try {
    const st = job.steps.find((s) => s.name === "normalize")!;
    st.status = "running";
    st.startedAt = new Date().toISOString();
    st.attempts += 1;
    await engine.jobs.save(job);
    ctx.publish({ type: "step", jobId, step: { ...st }, at: st.startedAt });
    await stages.stageNormalizeStore(ctx);
    await engine.jobs.save(job); // the artifact map must reach the next invocation
    // 0 on the fast path: the catalog API's own products are mapped in buildSpec, no Claude batches.
    return await stages.plannedBatchCount(ctx);
  } finally {
    await detach();
  }
}
stepNormalizeStore.maxRetries = 1;

async function stepNormalizeProducts(jobId: string, batchIndex: number) {
  "use step";
  const engine = await getEngine();
  const job = await engine.jobs.get(jobId);
  if (!job) throw new Error(`job ${jobId} not found`);
  const { ctx, detach } = withStream(engine, job);
  try {
    await stages.stageNormalizeProducts(ctx, batchIndex);
    await engine.jobs.save(job);
  } finally {
    await detach();
  }
}
stepNormalizeProducts.maxRetries = 1;

async function stepBuildSpec(jobId: string) {
  "use step";
  const engine = await getEngine();
  const job = await engine.jobs.get(jobId);
  if (!job) throw new Error(`job ${jobId} not found`);
  const { ctx, detach } = withStream(engine, job);
  try {
    const st = job.steps.find((s) => s.name === "normalize")!;
    try {
      const message = await stages.stageBuildSpec(ctx);
      st.status = "done";
      st.message = typeof message === "string" ? message : "";
    } catch (err) {
      st.status = "failed";
      st.error = err instanceof Error ? err.message : String(err);
      st.message = st.error;
      st.endedAt = new Date().toISOString();
      await engine.jobs.save(job);
      ctx.publish({ type: "step", jobId, step: { ...st }, at: st.endedAt });
      throw err;
    }
    st.endedAt = new Date().toISOString();
    await engine.jobs.save(job);
    ctx.publish({ type: "step", jobId, step: { ...st }, at: st.endedAt });
  } finally {
    await detach();
  }
}
stepBuildSpec.maxRetries = 0;

async function stepAssets(jobId: string) {
  "use step";
  await runStage(jobId, "assets", stages.stageAssets);
}
stepAssets.maxRetries = 1;

async function stepEnrich(jobId: string) {
  "use step";
  await runStage(jobId, "enrich", stages.stageEnrich);
}
stepEnrich.maxRetries = 0;

async function stepTemplate(jobId: string, source: "spec" | "store") {
  "use step";
  await runStage(jobId, "template", (ctx) => stages.stageTemplate(ctx, source));
}
stepTemplate.maxRetries = 0;

/** compose + build + deploy in one invocation: composed files never touch a shared disk. */
async function stepPublish(jobId: string) {
  "use step";
  const engine = await getEngine();
  const job = await engine.jobs.get(jobId);
  if (!job) throw new Error(`job ${jobId} not found`);
  const { ctx, detach } = withStream(engine, job);
  try {
    await stages.stagePublish(ctx);
  } finally {
    await detach();
  }
}
stepPublish.maxRetries = 0;

/**
 * The Shopee scrape gets its own invocation: it can run for minutes on its own, and the rebuild
 * after it is another normalize + enrich + publish. Returns how many products it added so the
 * workflow only pays for a rebuild when there is something to rebuild.
 */
async function stepShopee(jobId: string): Promise<number> {
  "use step";
  await runStage(jobId, "shopee", stages.stageShopeeScrape);
  const engine = await getEngine();
  const job = await engine.jobs.get(jobId);
  if (!job) throw new Error(`job ${jobId} not found`);
  return (await engine.jobs.getArtifact<number>(job, "shopee-added")) ?? 0;
}
stepShopee.maxRetries = 0;

async function stepSkip(jobId: string, names: StepName[], reason: string) {
  "use step";
  const engine = await getEngine();
  const job = await engine.jobs.get(jobId);
  if (!job) throw new Error(`job ${jobId} not found`);
  const { ctx, detach } = withStream(engine, job);
  try {
    if (job.status === "queued") await stages.setStatus(ctx, "running");
    for (const name of names) await stages.skipStep(ctx, name, reason);
  } finally {
    await detach();
  }
}
stepSkip.maxRetries = 0;

async function stepFinish(jobId: string, error: string | null) {
  "use step";
  const engine = await getEngine();
  const job = await engine.jobs.get(jobId);
  if (!job) throw new Error(`job ${jobId} not found`);
  const writable = getWritable<JobEvent>();
  const { ctx, detach } = withStream(engine, job);
  try {
    if (error) await stages.failJob(ctx, new Error(error));
    else await stages.finishJob(ctx);
  } finally {
    await detach();
    await writable.close();
  }
}
stepFinish.maxRetries = 0;

// ---------- workflows ----------

export async function buildStoreWorkflow(jobId: string) {
  "use workflow";
  try {
    await stepDetect(jobId);
    await stepIngest(jobId);
    await stepDiscover(jobId);
    await stepAttachments(jobId);
    await stepResearch(jobId);
    const batches = await stepNormalizeStore(jobId);
    // Batch 0 first so it writes the prompt cache the rest read; then the rest together.
    if (batches > 0) await stepNormalizeProducts(jobId, 0);
    if (batches > 1) await Promise.all(Array.from({ length: batches - 1 }, (_, i) => stepNormalizeProducts(jobId, i + 1)));
    await stepBuildSpec(jobId);
    await stepAssets(jobId);
    await stepEnrich(jobId);
    await stepTemplate(jobId, "spec");
    await stepPublish(jobId);
    // Shopee catalogs arrive minutes later, after the store is already live; rebuild only if they do.
    if ((await stepShopee(jobId)) > 0) {
      const after = await stepNormalizeStore(jobId);
      if (after > 0) await stepNormalizeProducts(jobId, 0);
      if (after > 1) await Promise.all(Array.from({ length: after - 1 }, (_, i) => stepNormalizeProducts(jobId, i + 1)));
      await stepBuildSpec(jobId);
      await stepAssets(jobId);
      await stepEnrich(jobId);
      await stepTemplate(jobId, "spec");
      await stepPublish(jobId);
    }
    await stepFinish(jobId, null);
    return { jobId, status: "done" };
  } catch (err) {
    await stepFinish(jobId, err instanceof Error ? err.message : String(err));
    return { jobId, status: "failed" };
  }
}

export async function rebuildStoreWorkflow(jobId: string) {
  "use workflow";
  try {
    await stepSkip(jobId, ["detect", "ingest", "discover", "attachments", "research", "normalize", "assets", "enrich"], "rebuild");
    await stepTemplate(jobId, "store");
    await stepPublish(jobId);
    await stepFinish(jobId, null);
    return { jobId, status: "done" };
  } catch (err) {
    await stepFinish(jobId, err instanceof Error ? err.message : String(err));
    return { jobId, status: "failed" };
  }
}
