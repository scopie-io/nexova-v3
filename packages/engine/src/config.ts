import path from "node:path";

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";
export type ReaderMode = "auto" | "off" | "jina" | "firecrawl" | "proxy";
export type StorageMode = "fs" | "vercel";

export interface EngineConfig {
  /** Absolute path of the project root (where templates/, stores/, data/ live by default). */
  rootDir: string;
  templatesDir: string;
  storesDir: string;
  dataDir: string;
  /** Anthropic model id for all Claude calls. */
  model: string;
  effort: Effort;
  /** Effort for the web-research step, which is browsing-bound rather than reasoning-bound. */
  researchEffort: Effort;
  /**
   * Effort per Claude step, overriding `effort` where a step does not need the reasoning.
   * Keys are gateway step names: "normalize-store", "normalize-products", "enrich", "vision".
   * Set NEXOVA_EFFORT_NORMALIZE / NEXOVA_EFFORT_ENRICH to trade output polish for latency.
   */
  stepEfforts: Record<string, Effort>;
  /**
   * Server-side refusal fallback: "default" lets Anthropic route by refusal category,
   * { model } pins a specific fallback model, null disables the feature.
   */
  fallbacks: "default" | { model: string } | null;
  /** When true, never call Claude; use the deterministic offline gateway (tests / no key yet). */
  offline: boolean;
  maxProducts: number;
  /**
   * Trust a marketplace API's own catalog: skip web research and per-product Claude
   * normalization when the catalog already arrived structured. Off means every job takes
   * the full ladder regardless of how good its sources were.
   */
  fastPath: boolean;
  /** Publish once before enrichment so the merchant sees a live store sooner. */
  earlyPublish: boolean;
  cacheTtlHours: number;
  /** Enable the optional Playwright provider (requires the `playwright` package). */
  browser: boolean;
  /** Public base URL for reporting live store links. */
  publicUrl: string;
  deployTarget: "local" | "netlify" | "vercel";
  netlifyToken: string | null;
  /** Per-source fetch timeout. */
  fetchTimeoutMs: number;
  /** Max wall-clock for the Claude research step. */
  researchTimeoutMs: number;
  engineVersion: string;

  // ---- ingestion strategy ladder ----
  /** Rendered-page reader used when direct fetches are blocked or thin. */
  reader: ReaderMode;
  jinaApiKey: string | null;
  firecrawlApiKey: string | null;
  /** Generic scraping proxy template, e.g. https://app.scrapingbee.com/api/v1/?api_key=KEY&render_js=true&url={url} */
  proxyUrlTemplate: string | null;
  /** Follow bio links / on-page links to discover the merchant's other shops. */
  discovery: boolean;
  /** Use a web search (DuckDuckGo HTML) to find the merchant's other profiles when links are missing. */
  searchDiscovery: boolean;
  maxDiscovered: number;
  /** Fall back to the Wayback Machine for blocked pages. */
  wayback: boolean;
  /** Max screenshots / images sent to vision per job. */
  maxVisionImages: number;

  // ---- TikTok Shop (RapidAPI) ----
  /** RapidAPI key for the TikTok Shop API provider: the only strategy that returns real TikTok Shop catalogs. */
  rapidApiKey: string | null;
  /** Regions tried, in order, when a TikTok Shop link does not say which market it belongs to. */
  tiktokShopRegions: string[];
  /** Catalog pages (20 products each) fetched per shop; every page costs one API credit. */
  tiktokShopMaxPages: number;
  /** Products per shop enriched with full details (photos, description, variants, stock); one credit each. */
  tiktokShopDetails: number;

  // ---- Shopee (RapidAPI) ----
  /**
   * Wall-clock budget for one Shopee scrape job, submit plus polling. Measured on a real MY shop:
   * ~47s before the submit returns a job id, ~162s to completion. This runs in its own pipeline
   * stage after the store is live, not in the ingest ladder, so it is free to wait minutes.
   */
  shopeeScraperTimeoutMs: number;

  // ---- storage ----
  /** Where state lives: "fs" (data/ and stores/ on disk) or "vercel" (Neon Postgres + Vercel Blob). */
  storage: StorageMode;
  databaseUrl: string | null;
  blobToken: string | null;
  /** Vercel access token + team for publishing stores through the Deployments API. */
  vercelToken: string | null;
  vercelTeamId: string | null;
}

const EFFORTS: Effort[] = ["low", "medium", "high", "xhigh", "max"];

export function loadConfig(env: NodeJS.ProcessEnv = process.env, rootDir = process.cwd()): EngineConfig {
  const abs = (p: string | undefined, fallback: string) => path.resolve(rootDir, p && p.trim() ? p : fallback);
  const effortRaw = (env.NEXOVA_EFFORT || "high").toLowerCase() as Effort;
  const fallbackRaw = (env.NEXOVA_FALLBACKS ?? env.NEXOVA_FALLBACK_MODEL ?? "default").trim();
  const fallbacks: EngineConfig["fallbacks"] = !fallbackRaw || /^(off|none|0|false)$/i.test(fallbackRaw) ? null : /^default$/i.test(fallbackRaw) ? "default" : { model: fallbackRaw };
  const readerRaw = (env.NEXOVA_READER || "auto").toLowerCase();
  const reader: ReaderMode = (["auto", "off", "jina", "firecrawl", "proxy"] as ReaderMode[]).includes(readerRaw as ReaderMode) ? (readerRaw as ReaderMode) : "auto";
  return {
    rootDir,
    templatesDir: abs(env.NEXOVA_TEMPLATES_DIR, "templates"),
    // On Vercel only /tmp is writable; with Neon + Blob these folders hold scratch files only.
    storesDir: abs(env.NEXOVA_STORES_DIR, env.VERCEL ? "/tmp/nexova/stores" : "stores"),
    dataDir: abs(env.NEXOVA_DATA_DIR, env.VERCEL ? "/tmp/nexova/data" : "data"),
    model: env.NEXOVA_MODEL?.trim() || "claude-opus-5",
    effort: EFFORTS.includes(effortRaw) ? effortRaw : "high",
    researchEffort: (() => {
      const raw = (env.NEXOVA_RESEARCH_EFFORT || "medium").toLowerCase() as Effort;
      return EFFORTS.includes(raw) ? raw : "medium";
    })(),
    stepEfforts: (() => {
      const pick = (raw: string | undefined): Effort | null => {
        const v = (raw ?? "").trim().toLowerCase() as Effort;
        return EFFORTS.includes(v) ? v : null;
      };
      const normalize = pick(env.NEXOVA_EFFORT_NORMALIZE);
      const enrich = pick(env.NEXOVA_EFFORT_ENRICH);
      const out: Record<string, Effort> = {};
      if (normalize) {
        out["normalize-store"] = normalize;
        out["normalize-products"] = normalize;
      }
      if (enrich) out.enrich = enrich;
      return out;
    })(),
    fallbacks,
    offline: env.NEXOVA_OFFLINE === "1" || (!hasCredential(env) && env.NEXOVA_OFFLINE !== "0"),
    maxProducts: clampInt(env.NEXOVA_MAX_PRODUCTS, 60, 1, 500),
    fastPath: env.NEXOVA_FAST_PATH !== "0",
    earlyPublish: env.NEXOVA_EARLY_PUBLISH !== "0",
    cacheTtlHours: clampInt(env.NEXOVA_CACHE_TTL_HOURS, 24, 0, 24 * 30),
    browser: env.NEXOVA_BROWSER === "1",
    publicUrl: (env.NEXOVA_PUBLIC_URL || `http://localhost:${env.PORT || 4000}`).replace(/\/+$/, ""),
    deployTarget: env.NEXOVA_DEPLOY_TARGET === "netlify" ? "netlify" : env.NEXOVA_DEPLOY_TARGET === "vercel" ? "vercel" : "local",
    netlifyToken: env.NETLIFY_AUTH_TOKEN?.trim() || null,
    fetchTimeoutMs: clampInt(env.NEXOVA_FETCH_TIMEOUT_MS, 15_000, 1000, 120_000),
    researchTimeoutMs: clampInt(env.NEXOVA_RESEARCH_TIMEOUT_MS, 10 * 60_000, 30_000, 60 * 60_000),
    engineVersion: "0.2.0",
    reader,
    jinaApiKey: env.JINA_API_KEY?.trim() || null,
    firecrawlApiKey: env.FIRECRAWL_API_KEY?.trim() || null,
    proxyUrlTemplate: env.NEXOVA_PROXY_URL?.trim() || null,
    discovery: env.NEXOVA_DISCOVERY !== "0",
    searchDiscovery: env.NEXOVA_SEARCH_DISCOVERY !== "0",
    maxDiscovered: clampInt(env.NEXOVA_MAX_DISCOVERED, 6, 0, 20),
    wayback: env.NEXOVA_WAYBACK !== "0",
    maxVisionImages: clampInt(env.NEXOVA_MAX_VISION_IMAGES, 20, 0, 60),
    rapidApiKey: realSecret(env.RAPIDAPI_KEY) ?? realSecret(env.NEXOVA_RAPIDAPI_KEY),
    tiktokShopRegions: (env.NEXOVA_TIKTOK_SHOP_REGIONS || "MY,SG,US").split(",").map((s) => s.trim().toUpperCase()).filter(Boolean),
    tiktokShopMaxPages: clampInt(env.NEXOVA_TIKTOK_SHOP_MAX_PAGES, 3, 1, 25),
    tiktokShopDetails: clampInt(env.NEXOVA_TIKTOK_SHOP_DETAILS, 6, 0, 60),
    shopeeScraperTimeoutMs: clampInt(env.NEXOVA_SHOPEE_TIMEOUT_MS, 240_000, 5_000, 900_000),
    storage: (() => {
      const raw = (env.NEXOVA_STORAGE || "auto").toLowerCase();
      const cloud = !!env.DATABASE_URL?.trim() && !!env.BLOB_READ_WRITE_TOKEN?.trim();
      if (raw === "vercel") return "vercel";
      if (raw === "fs") return "fs";
      return cloud ? "vercel" : "fs";
    })(),
    databaseUrl: env.DATABASE_URL?.trim() || null,
    blobToken: env.BLOB_READ_WRITE_TOKEN?.trim() || null,
    // NEXOVA_VERCEL_TOKEN avoids the reserved VERCEL_ prefix on Vercel itself; VERCEL_TOKEN still works locally.
    vercelToken: env.NEXOVA_VERCEL_TOKEN?.trim() || env.VERCEL_TOKEN?.trim() || null,
    vercelTeamId: env.VERCEL_TEAM_ID?.trim() || null,
  };
}

/** A real credential, not the placeholder from .env.example. */
function hasCredential(env: NodeJS.ProcessEnv): boolean {
  const key = (env.ANTHROPIC_API_KEY ?? "").trim();
  const token = (env.ANTHROPIC_AUTH_TOKEN ?? "").trim();
  const real = (v: string) => v.length >= 20 && !/\.\.\.$/.test(v) && !/^(your|sk-ant-\.\.\.|changeme|xxx)/i.test(v);
  return real(key) || real(token);
}

/** A secret that is actually set, not the placeholder from .env.example. */
function realSecret(raw: string | undefined): string | null {
  const v = (raw ?? "").trim();
  if (v.length < 16 || /\.\.\.$/.test(v) || /^(your|changeme|xxx)/i.test(v)) return null;
  return v;
}

function clampInt(raw: string | undefined, fallback: number, min: number, max: number): number {
  const n = Number.parseInt(raw ?? "", 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}
