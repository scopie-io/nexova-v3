import type { LogRecord } from "../util/log.js";
import type { Attachment } from "./signals.js";

export const STEP_NAMES = [
  "detect",
  "ingest",
  "discover",
  "attachments",
  "research",
  "normalize",
  "assets",
  "preview",
  "enrich",
  "template",
  "compose",
  "build",
  "deploy",
] as const;
export type StepName = (typeof STEP_NAMES)[number];

export type StepStatus = "pending" | "running" | "done" | "failed" | "skipped";

export interface StepState {
  name: StepName;
  status: StepStatus;
  startedAt: string | null;
  endedAt: string | null;
  message: string;
  error: string | null;
  attempts: number;
}

export type JobStatus = "queued" | "running" | "done" | "failed" | "cancelled";

export interface JobOptions {
  /** Force a template id instead of letting the engine choose. */
  templateId?: string | null;
  /** Skip the build/deploy steps (spec + composed site only). */
  skipBuild?: boolean;
  /** Skip Claude web research even when online. */
  skipResearch?: boolean;
  /** Skip link discovery (bio links, on-page links, search). */
  skipDiscovery?: boolean;
  /**
   * "auto" (default) takes the fast path when a marketplace API already returned a structured
   * catalog: research and per-product Claude normalization are skipped. "off" always runs the
   * full ladder, which is what to use when comparing quality between the two.
   */
  fastPath?: "auto" | "off";
  /** Preferred store slug. */
  slug?: string | null;
  /** Preferred currency override. */
  currency?: string | null;
  /** Free-form instructions from the merchant (tone, what to emphasize). */
  instructions?: string | null;
}

export interface UsageSummary {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  webSearches: number;
  webFetches: number;
  costUsd: number;
}

export interface JobRecord {
  id: string;
  status: JobStatus;
  input: {
    raw: string;
    options: JobOptions;
    attachments: Attachment[];
  };
  steps: StepState[];
  slug: string | null;
  templateId: string | null;
  siteUrl: string | null;
  /** True while siteUrl points at the pre-enrichment publish and a better one is still coming. */
  preview: boolean;
  usage: UsageSummary;
  error: string | null;
  createdAt: string;
  updatedAt: string;
  /** Files produced by the pipeline (relative to dataDir/jobs/<id>/) */
  artifacts: Record<string, string>;
  /** Workflow run id when the job runs as a durable workflow (Vercel); null in-process. */
  runId?: string | null;
}

/** Just enough of a product to render a card mid-build. */
export interface JobProductPreview {
  title: string;
  priceText: string;
  image: string | null;
}

export type JobEvent =
  | { type: "status"; jobId: string; status: JobStatus; at: string }
  | { type: "step"; jobId: string; step: StepState; at: string }
  | { type: "log"; jobId: string; record: LogRecord; at: string }
  | { type: "usage"; jobId: string; usage: UsageSummary; at: string }
  | { type: "progress"; jobId: string; step: StepName; message: string; at: string }
  /** A few products as soon as ingestion finds them, so the merchant sees real content while waiting. */
  | { type: "products"; jobId: string; products: JobProductPreview[]; total: number; at: string }
  | { type: "done"; jobId: string; job: JobRecord; at: string }
  | { type: "error"; jobId: string; error: string; at: string };

export function emptyUsage(): UsageSummary {
  return { calls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, webSearches: 0, webFetches: 0, costUsd: 0 };
}

export function initialSteps(): StepState[] {
  return STEP_NAMES.map((name) => ({
    name,
    status: "pending",
    startedAt: null,
    endedAt: null,
    message: "",
    error: null,
    attempts: 0,
  }));
}
