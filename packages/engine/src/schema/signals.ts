/**
 * Raw signals: everything the ingestion layer can gather about a source before Claude
 * normalizes it. Deliberately loose - providers fill whatever they can.
 */
import type { Platform, SourceKind } from "./store-spec.js";

export interface RawProduct {
  title: string;
  description?: string | null;
  priceText?: string | null;
  price?: number | null;
  currency?: string | null;
  compareAtPrice?: number | null;
  url?: string | null;
  images?: string[];
  externalId?: string | null;
  soldCount?: number | null;
  rating?: number | null;
  ratingCount?: number | null;
  stock?: number | null;
  variants?: Array<{ title: string; price?: number | null; sku?: string | null; image?: string | null; stock?: number | null }>;
  options?: Array<{ name: string; values: string[] }>;
  tags?: string[];
  category?: string | null;
  /** Which provider produced this record (used for precedence when merging). */
  via: string;
  /** Where the evidence came from: a URL or an attachment id. */
  evidence?: string | null;
  sourcePlatform?: Platform | null;
  /** Merge/sanity notes, surfaced as warnings. */
  notes?: string[];
}

export interface RawProfile {
  name: string | null;
  handle: string | null;
  bio: string | null;
  avatar: string | null;
  followers: number | null;
  following?: number | null;
  likes?: number | null;
  verified: boolean | null;
  website: string | null;
  category?: string | null;
  location?: string | null;
  email?: string | null;
  phone?: string | null;
}

export type SourceStatus = "ok" | "partial" | "blocked" | "failed" | "skipped";

export interface DetectedUrl {
  url: string;
  platform: Platform;
  kind: SourceKind;
  handle: string | null;
  /** Country/region code derived from the domain (my, sg, id, ph, th, vn, tw, br ...). */
  region: string | null;
  externalId: string | null;
}

export interface ProviderAttempt {
  provider: string;
  ok: boolean;
  ms: number;
  note: string;
}

export interface SourceSignals extends DetectedUrl {
  id: string;
  /** The original token the user pasted. */
  input: string;
  status: SourceStatus;
  /** Providers that contributed data. */
  providers: string[];
  /** Every provider that ran, with outcome, for the coverage report. */
  attempts: ProviderAttempt[];
  /** True when this source was found by link discovery rather than pasted by the merchant. */
  discovered: boolean;
  /** Which trusted page led to this discovered source. */
  discoveredFrom: string | null;
  title: string | null;
  description: string | null;
  siteName: string | null;
  canonicalUrl: string | null;
  openGraph: Record<string, string>;
  jsonLd: unknown[];
  oembed: Record<string, unknown> | null;
  /** Small, provider-specific structured extracts (never the whole page state). */
  embedded: Record<string, unknown>;
  /** Readable page text, clamped. */
  text: string;
  /** Rendered-page markdown from a reader service, clamped. */
  markdown: string;
  images: string[];
  links: string[];
  products: RawProduct[];
  profile: RawProfile | null;
  /** Contact facts found on the page (wa.me links, mailto, tel). */
  contacts: { whatsapp: string | null; email: string | null; phone: string | null };
  /** Full-page screenshots captured by the browser provider (absolute paths) - fed to vision. */
  screenshots: string[];
  errors: string[];
  fetchedAt: string;
  fromCache: boolean;
  httpStatus: number | null;
}

export type AttachmentKind = "image" | "csv" | "json" | "pdf" | "text" | "other";

export interface Attachment {
  id: string;
  name: string;
  mime: string;
  kind: AttachmentKind;
  /** Absolute path on disk. */
  path: string;
  size: number;
  /** "user" for uploads, "capture" for browser screenshots taken by the engine. */
  origin: "user" | "capture";
}

export interface AttachmentExtract {
  attachmentId: string;
  name: string;
  kind: AttachmentKind;
  platformGuess: Platform;
  pageType: "shop" | "product_list" | "product" | "profile" | "cart" | "chat" | "spreadsheet" | "other";
  shopName: string | null;
  handle: string | null;
  bio: string | null;
  followers: number | null;
  rating: number | null;
  location: string | null;
  contacts: { whatsapp: string | null; email: string | null; phone: string | null; website: string | null };
  socialHandles: Array<{ platform: Platform; handle: string }>;
  products: RawProduct[];
  visibleText: string;
  notes: string;
  confidence: number;
  via: "vision" | "csv" | "json" | "text" | "none";
}

export interface IngestInput {
  raw: string;
  urls: DetectedUrl[];
  /** Non-URL lines the user pasted: product lists, descriptions, instructions. */
  texts: string[];
  attachments: Attachment[];
}

export interface CoverageSource {
  url: string;
  platform: Platform;
  kind: SourceKind;
  status: SourceStatus;
  discovered: boolean;
  strategies: string[];
  attempted: string[];
  products: number;
  images: number;
  profile: boolean;
  contacts: boolean;
  note: string;
}

export interface CoverageReport {
  sources: CoverageSource[];
  attachments: { total: number; extracted: number; products: number; images: number };
  totals: { products: number; withPrice: number; withImages: number; profiles: number; contacts: number; platforms: string[] };
  gaps: string[];
  recommendations: string[];
  /** 0..1 - how complete the picture is. */
  score: number;
}

export interface IngestResult {
  sources: SourceSignals[];
  texts: string[];
  attachments: AttachmentExtract[];
  discovered: DetectedUrl[];
  /** Cross-source merged, sanity-checked product candidates (what normalization consumes). */
  products: RawProduct[];
  coverage: CoverageReport;
}

export interface ResearchCitation {
  url: string;
  title: string;
}

export interface ResearchFindings {
  /** Markdown notes written by Claude after browsing: brand facts, products, prices, images, contact. */
  markdown: string;
  citations: ResearchCitation[];
  searches: number;
  fetches: number;
  /** True when research was skipped (offline mode, or nothing worth researching). */
  skipped: boolean;
}

export function emptySignals(det: DetectedUrl, input: string, id: string): SourceSignals {
  return {
    ...det,
    id,
    input,
    status: "skipped",
    providers: [],
    attempts: [],
    discovered: false,
    discoveredFrom: null,
    title: null,
    description: null,
    siteName: null,
    canonicalUrl: null,
    openGraph: {},
    jsonLd: [],
    oembed: null,
    embedded: {},
    text: "",
    markdown: "",
    images: [],
    links: [],
    products: [],
    profile: null,
    contacts: { whatsapp: null, email: null, phone: null },
    screenshots: [],
    errors: [],
    fetchedAt: new Date().toISOString(),
    fromCache: false,
    httpStatus: null,
  };
}

export function emptyCoverage(): CoverageReport {
  return { sources: [], attachments: { total: 0, extracted: 0, products: 0, images: 0 }, totals: { products: 0, withPrice: 0, withImages: 0, profiles: 0, contacts: 0, platforms: [] }, gaps: [], recommendations: [], score: 0 };
}
