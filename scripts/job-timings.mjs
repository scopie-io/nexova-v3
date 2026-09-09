#!/usr/bin/env node
/**
 * Per-step wall-clock for past builds, so a latency change can be judged against a baseline.
 *
 * Steps already carry startedAt/endedAt (schema/job.ts), and every Claude call carries durationMs
 * in data/usage/ledger.jsonl, so nothing here needs new instrumentation.
 *
 *   node scripts/job-timings.mjs             # every job, newest first
 *   node scripts/job-timings.mjs job_a280..  # one job
 *   node scripts/job-timings.mjs --median    # median per step across all jobs
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function dataDir() {
  const raw = await fs.readFile(path.join(root, ".env"), "utf8").catch(() => "");
  const m = raw.match(/^NEXOVA_DATA_DIR=(.*)$/m);
  const dir = (process.env.NEXOVA_DATA_DIR || (m ? m[1] : "") || "./data").trim().replace(/^["']|["']$/g, "");
  return path.resolve(root, dir);
}

const ms = (a, b) => (a && b ? new Date(b).getTime() - new Date(a).getTime() : null);
const secs = (v) => (v == null ? "—" : `${(v / 1000).toFixed(1)}s`);
const pad = (s, n) => String(s).padEnd(n);
const lpad = (s, n) => String(s).padStart(n);

async function loadJobs(dir) {
  const jobsDir = path.join(dir, "jobs");
  const entries = await fs.readdir(jobsDir).catch(() => []);
  const jobs = [];
  for (const id of entries) {
    const file = path.join(jobsDir, id, "job.json");
    const raw = await fs.readFile(file, "utf8").catch(() => null);
    if (!raw) continue;
    try {
      jobs.push(JSON.parse(raw));
    } catch {
      /* a half-written record is not worth failing the report over */
    }
  }
  return jobs.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

/** Per-Claude-call durations, so the report can show what a slow step was actually waiting on. */
async function loadLedger(dir) {
  const raw = await fs.readFile(path.join(dir, "usage", "ledger.jsonl"), "utf8").catch(() => "");
  const byJob = new Map();
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line);
      const list = byJob.get(e.jobId) ?? [];
      list.push(e);
      byJob.set(e.jobId, list);
    } catch {
      /* skip */
    }
  }
  return byJob;
}

function reportJob(job, calls) {
  const total = ms(job.createdAt, job.updatedAt);
  const rows = job.steps
    .map((s) => ({ name: s.name, status: s.status, dur: ms(s.startedAt, s.endedAt) }))
    .filter((r) => r.dur != null)
    .sort((a, b) => b.dur - a.dur);

  console.log(`\n${job.id}  ${job.status}  ${job.slug ?? "-"}  total ${secs(total)}  $${(job.usage?.costUsd ?? 0).toFixed(4)}  ${job.usage?.calls ?? 0} AI calls`);
  console.log(`  ${pad("step", 14)}${pad("status", 9)}${lpad("time", 9)}${lpad("share", 8)}`);
  for (const r of rows) {
    const share = total ? `${((r.dur / total) * 100).toFixed(1)}%` : "—";
    console.log(`  ${pad(r.name, 14)}${pad(r.status, 9)}${lpad(secs(r.dur), 9)}${lpad(share, 8)}`);
  }

  const mine = (calls ?? []).filter((c) => c.durationMs != null);
  if (mine.length) {
    const claude = mine.reduce((n, c) => n + c.durationMs, 0);
    console.log(`  ${pad("— AI calls", 14)}${pad("", 9)}${lpad(secs(claude), 9)}${lpad(total ? `${((claude / total) * 100).toFixed(1)}%` : "—", 8)}`);
    for (const c of mine.sort((a, b) => b.durationMs - a.durationMs)) {
      console.log(`      ${pad(c.step, 20)}${lpad(secs(c.durationMs), 9)}  $${(c.costUsd ?? 0).toFixed(4)}`);
    }
  }
}

function reportMedians(jobs) {
  const byStep = new Map();
  for (const job of jobs) {
    for (const s of job.steps) {
      const dur = ms(s.startedAt, s.endedAt);
      if (dur == null || s.status === "skipped") continue;
      const list = byStep.get(s.name) ?? [];
      list.push(dur);
      byStep.set(s.name, list);
    }
  }
  const median = (list) => {
    const v = [...list].sort((a, b) => a - b);
    const mid = Math.floor(v.length / 2);
    return v.length % 2 ? v[mid] : Math.round((v[mid - 1] + v[mid]) / 2);
  };
  const rows = [...byStep.entries()].map(([name, list]) => ({ name, n: list.length, med: median(list) })).sort((a, b) => b.med - a.med);
  console.log(`\nmedian per step across ${jobs.length} job(s)`);
  console.log(`  ${pad("step", 14)}${lpad("n", 4)}${lpad("median", 10)}`);
  for (const r of rows) console.log(`  ${pad(r.name, 14)}${lpad(r.n, 4)}${lpad(secs(r.med), 10)}`);
  console.log(`\n  as an ETA table (ms): ${JSON.stringify(Object.fromEntries(rows.map((r) => [r.name, r.med])))}`);
}

async function main() {
  const args = process.argv.slice(2);
  const dir = await dataDir();
  const jobs = await loadJobs(dir);
  if (!jobs.length) {
    console.log(`no job records under ${path.join(dir, "jobs")}`);
    return;
  }
  const ledger = await loadLedger(dir);
  const wanted = args.filter((a) => !a.startsWith("--"));
  const selected = wanted.length ? jobs.filter((j) => wanted.some((w) => j.id.includes(w))) : jobs;

  if (args.includes("--median")) return reportMedians(selected);
  for (const job of selected) reportJob(job, ledger.get(job.id));
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
