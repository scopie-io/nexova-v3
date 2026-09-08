/**
 * JobLauncher backed by the Workflow SDK: jobs are durable runs, progress is the run's stream.
 */
import { getRun, start } from "workflow/api";
import type { Engine, JobEvent, JobRecord } from "@nexova/engine";
import type { JobLauncher } from "../app.js";
import { buildStoreWorkflow, rebuildStoreWorkflow } from "./build-store.js";

const TERMINAL = new Set(["completed", "failed", "cancelled"]);

export function workflowLauncher(engine: Engine): JobLauncher {
  async function launch(job: JobRecord, workflow: (jobId: string) => Promise<unknown>): Promise<JobRecord> {
    const run = await start(workflow as (jobId: string) => Promise<{ jobId: string; status: string }>, [job.id]);
    job.runId = run.runId;
    await engine.jobs.save(job);
    return job;
  }

  return {
    id: "workflow",
    async create(raw, options, files) {
      const job = await engine.jobs.create(raw, options, files);
      return launch(job, buildStoreWorkflow);
    },
    async rebuild(slug, options) {
      const job = await engine.jobs.create(`rebuild:${slug}`, { ...options, slug });
      return launch(job, rebuildStoreWorkflow);
    },
    async cancel(jobId) {
      const job = await engine.jobs.get(jobId);
      if (!job?.runId) return false;
      const run = getRun(job.runId) as unknown as { cancel?: () => Promise<unknown> };
      if (typeof run.cancel !== "function") return false;
      await run.cancel();
      job.status = "cancelled";
      job.error = "cancelled by user";
      await engine.jobs.save(job);
      return true;
    },
    async *events(job, signal, startIndex) {
      if (!job.runId) {
        yield { type: "done", jobId: job.id, job, at: new Date().toISOString() };
        return;
      }
      const run = getRun(job.runId);
      const reader = run.getReadable({ startIndex }).getReader();
      const onAbort = () => void reader.cancel().catch(() => undefined);
      signal.addEventListener("abort", onAbort, { once: true });
      let sawTerminal = false;
      try {
        while (!signal.aborted) {
          const { value, done } = await reader.read();
          if (done) break;
          const event = value as JobEvent;
          yield event;
          if (event.type === "done" || (event.type === "status" && (event.status === "failed" || event.status === "cancelled"))) {
            sawTerminal = true;
            break;
          }
        }
      } finally {
        signal.removeEventListener("abort", onAbort);
        reader.releaseLock();
      }
      if (!sawTerminal && !signal.aborted) {
        // The stream closed without a terminal event (crash or cancellation): report the record as it stands.
        const latest = (await engine.jobs.get(job.id)) ?? job;
        const status = await run.status.catch(() => "unknown");
        if (TERMINAL.has(status) && latest.status === "running") {
          latest.status = status === "completed" ? "done" : status === "cancelled" ? "cancelled" : "failed";
          latest.error = latest.error ?? (status === "failed" ? "workflow run failed" : null);
          await engine.jobs.save(latest);
        }
        yield { type: "done", jobId: job.id, job: latest, at: new Date().toISOString() };
      }
    },
  };
}
