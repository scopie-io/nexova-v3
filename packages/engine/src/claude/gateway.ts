/**
 * The ClaudeGateway is the only seam between the pipeline and the model. The pipeline never
 * imports the Anthropic SDK directly, which keeps every step testable offline and lets the
 * model layer evolve (models, effort, tools) without touching orchestration.
 */
import type { EnrichmentDraft, ProductDraft, StoreDraft } from "../schema/drafts.js";
import type { Attachment, AttachmentExtract, IngestResult, RawProduct, ResearchFindings } from "../schema/signals.js";
import type { StoreSpec } from "../schema/store-spec.js";
import type { TemplateManifest } from "../schema/manifest.js";

export interface GatewayContext {
  jobId: string | null;
  signal?: AbortSignal;
  /** Human-readable progress for the UI. */
  onProgress?: (message: string) => void;
}

export interface ResearchInput {
  ingest: IngestResult;
  /** Merchant instructions (tone, focus). */
  instructions: string | null;
}

export interface NormalizeStoreInput {
  ingest: IngestResult;
  research: ResearchFindings;
  instructions: string | null;
  currencyHint: string | null;
  localeHint: string | null;
}

export interface NormalizeProductsInput {
  /** Raw product candidates for this batch (may be empty when products only exist in text/research). */
  rawProducts: RawProduct[];
  /** Full context so Claude can also pull products that only appear in text/research. */
  ingest: IngestResult;
  research: ResearchFindings;
  store: StoreDraft;
  batchIndex: number;
  batchCount: number;
  maxProducts: number;
}

export interface EnrichInput {
  spec: StoreSpec;
  templates: TemplateManifest[];
  /** Local image files (absolute paths) to look at for palette/mood. */
  imagePaths: string[];
  instructions: string | null;
}

export interface AttachmentVisionInput {
  images: Attachment[];
  /** What we already know (links pasted, platforms), to help disambiguate. */
  context: string;
}

export interface GatewayPing {
  servedBy: string;
  text: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  durationMs: number;
}

export interface SchemaCheck {
  name: string;
  ok: boolean;
  error: string | null;
  ms: number;
}

export interface ClaudeGateway {
  readonly id: string;
  research(input: ResearchInput, ctx: GatewayContext): Promise<ResearchFindings>;
  normalizeStore(input: NormalizeStoreInput, ctx: GatewayContext): Promise<StoreDraft>;
  normalizeProducts(input: NormalizeProductsInput, ctx: GatewayContext): Promise<ProductDraft[]>;
  enrich(input: EnrichInput, ctx: GatewayContext): Promise<EnrichmentDraft>;
  /** Read merchant screenshots / captured pages with vision and return structured extracts. */
  extractFromAttachments(input: AttachmentVisionInput, ctx: GatewayContext): Promise<AttachmentExtract[]>;
  /** Cheap round-trip that proves credentials and model access work. */
  ping(ctx: GatewayContext): Promise<GatewayPing>;
  /**
   * Compile every structured-output schema against the API. Schema limits (union count, grammar
   * size) are only enforced at call time, so this turns a mid-job failure into a preflight check.
   */
  validateSchemas(ctx: GatewayContext): Promise<SchemaCheck[]>;
}

export class NexovaError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly retryable = false,
  ) {
    super(message);
    this.name = "NexovaError";
  }
}
