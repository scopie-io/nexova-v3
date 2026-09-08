/**
 * Usage ledger: every Claude call is appended to data/usage/ledger.jsonl with token counts
 * and an estimated cost, so spend can be audited per job, per step, per model, per day.
 */
import path from "node:path";
import { promises as fs } from "node:fs";
import type { EngineConfig } from "../config.js";
import { emptyUsage, type UsageSummary } from "../schema/job.js";
import { appendLine, ensureDir } from "../util/fsx.js";
import { estimateCostUsd } from "./pricing.js";

export interface UsageLike {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
  server_tool_use?: { web_search_requests: number; web_fetch_requests: number } | null;
}

export interface LedgerEntry {
  at: string;
  jobId: string | null;
  step: string;
  model: string;
  servedBy: string | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  webSearches: number;
  webFetches: number;
  durationMs: number;
  stopReason: string | null;
  costUsd: number;
}

export interface UsageReport {
  total: UsageSummary;
  byJob: Record<string, UsageSummary>;
  byModel: Record<string, UsageSummary>;
  byStep: Record<string, UsageSummary>;
  byDay: Record<string, UsageSummary>;
  entries: number;
  since: string | null;
  until: string | null;
}

function add(target: UsageSummary, e: LedgerEntry): UsageSummary {
  target.calls += 1;
  target.inputTokens += e.inputTokens;
  target.outputTokens += e.outputTokens;
  target.cacheReadTokens += e.cacheReadTokens;
  target.cacheWriteTokens += e.cacheWriteTokens;
  target.webSearches += e.webSearches;
  target.webFetches += e.webFetches;
  target.costUsd = Math.round((target.costUsd + e.costUsd) * 1_000_000) / 1_000_000;
  return target;
}

export class UsageLedger {
  private readonly file: string;
  private readonly listeners = new Set<(entry: LedgerEntry) => void>();

  constructor(private readonly config: EngineConfig) {
    this.file = path.join(config.dataDir, "usage", "ledger.jsonl");
  }

  onEntry(fn: (entry: LedgerEntry) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  async record(params: { jobId: string | null; step: string; model: string; servedBy?: string | null; usage: UsageLike; durationMs: number; stopReason?: string | null }): Promise<LedgerEntry> {
    const u = params.usage;
    const counts = {
      inputTokens: u.input_tokens ?? 0,
      outputTokens: u.output_tokens ?? 0,
      cacheReadTokens: u.cache_read_input_tokens ?? 0,
      cacheWriteTokens: u.cache_creation_input_tokens ?? 0,
      webSearches: u.server_tool_use?.web_search_requests ?? 0,
    };
    const model = params.servedBy || params.model;
    const entry: LedgerEntry = {
      at: new Date().toISOString(),
      jobId: params.jobId,
      step: params.step,
      model: params.model,
      servedBy: params.servedBy ?? null,
      ...counts,
      webFetches: u.server_tool_use?.web_fetch_requests ?? 0,
      durationMs: params.durationMs,
      stopReason: params.stopReason ?? null,
      costUsd: estimateCostUsd(model, counts),
    };
    await appendLine(this.file, JSON.stringify(entry));
    for (const l of this.listeners) {
      try {
        l(entry);
      } catch {
        /* ignore */
      }
    }
    return entry;
  }

  async entries(filter: { jobId?: string; since?: Date } = {}): Promise<LedgerEntry[]> {
    let raw = "";
    try {
      raw = await fs.readFile(this.file, "utf8");
    } catch {
      return [];
    }
    const out: LedgerEntry[] = [];
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        const e = JSON.parse(line) as LedgerEntry;
        if (filter.jobId && e.jobId !== filter.jobId) continue;
        if (filter.since && new Date(e.at) < filter.since) continue;
        out.push(e);
      } catch {
        /* skip corrupt line */
      }
    }
    return out;
  }

  async report(filter: { jobId?: string; since?: Date } = {}): Promise<UsageReport> {
    const entries = await this.entries(filter);
    const report: UsageReport = { total: emptyUsage(), byJob: {}, byModel: {}, byStep: {}, byDay: {}, entries: entries.length, since: entries[0]?.at ?? null, until: entries[entries.length - 1]?.at ?? null };
    for (const e of entries) {
      add(report.total, e);
      add((report.byJob[e.jobId ?? "none"] ??= emptyUsage()), e);
      add((report.byModel[e.servedBy ?? e.model] ??= emptyUsage()), e);
      add((report.byStep[e.step] ??= emptyUsage()), e);
      add((report.byDay[e.at.slice(0, 10)] ??= emptyUsage()), e);
    }
    return report;
  }

  async init(): Promise<void> {
    await ensureDir(path.dirname(this.file));
  }
}

export function sumUsage(entries: LedgerEntry[]): UsageSummary {
  return entries.reduce(add, emptyUsage());
}
