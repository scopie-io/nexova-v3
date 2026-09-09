/**
 * Shopee via RapidAPI ("Shopee Product Scraper" by Gio).
 *
 * Shopee's own v4 endpoints (see `shopeeApiProvider` in platforms.ts) are free but blocked or
 * rate-limited most of the time, so a pasted shop link often yields nothing. This provider is the
 * paid backstop: it takes the shop URL as-is and returns the merchant's real catalog.
 *
 *   shop link     -> /shopee?shopUrl=...&country=MY&maxItems=N
 *   product link  -> the seller's shop URL rebuilt from the id pair, then the same call
 *
 * Two things make it unlike the TikTok Shop provider:
 *
 *   1. It is asynchronous. The scrape call answers 202 with a jobId and a poll interval; the
 *      products arrive from /jobs/{id}. One scrape is therefore one submit plus a handful of
 *      polls, all of which must finish inside the provider's wall-clock budget.
 *   2. Every call is billed, polls included. The plan's "Searches" meter counts the submit AND
 *      each poll - confirmed against a BASIC key: submit + 3 polls exhausted a 5-search month -
 *      on top of a separate per-product "Results" meter. So a shop costs roughly
 *      1 + ceil(job seconds / poll interval) searches, which makes that interval a price and
 *      not just a latency knob: never poll faster than the server asks, never re-run a shop.
 *
 * Because of the cost it runs in the "fallback" stage: only when the free strategies left the
 * source thin. A shop the direct fetch already read is never paid for twice.
 */
import type { EngineConfig } from "../../config.js";
import type { RawProduct, SourceSignals } from "../../schema/signals.js";
import { fetchJson } from "../http.js";
import { sleep } from "../../util/retry.js";
import { isThinSource, mergeUnique, type Provider, type ProviderContext } from "./types.js";

type AnyRec = Record<string, unknown>;

export const SHOPEE_SCRAPER_HOST = "shopee-product-scraper2.p.rapidapi.com";
/** The eight marketplaces the API knows. Shopee also runs .tw and .co.th aliases it will not accept. */
export const SHOPEE_SCRAPER_COUNTRIES = ["BR", "ID", "TH", "MY", "SG", "PH", "VN", "MX"];

const VIA = "shopee-scraper-api";
/** The API caps a single scrape here; asking for more is silently truncated. */
const MAX_ITEMS_CAP = 200;
/**
 * Bounds on the server-suggested poll interval. The floor is high because every poll is a billed
 * search: a response missing `pollAfterSeconds` must not become a fast, expensive spin.
 */
const MIN_POLL_MS = 5_000;
const MAX_POLL_MS = 15_000;

// ---------------------------------------------------------------------------------------------
// Pure mappers (unit-tested against recorded responses)
// ---------------------------------------------------------------------------------------------

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

function num(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = Number.parseFloat(v.replace(/[^\d.]/g, ""));
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** First present key. Scraper payloads rename fields between versions; keep the aliases in one place. */
function pick(row: AnyRec, keys: string[]): unknown {
  for (const k of keys) if (row[k] != null && row[k] !== "") return row[k];
  return null;
}

/** Ids arrive as JSON numbers (itemId: 22786742010), so `str` alone would drop them. */
function id(v: unknown): string | null {
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return str(v);
}

/**
 * `historicalSoldEstimated` is a display string, not a number: "500+", "1k+", "<100".
 * "1k+" must not become 1, and "<100" is only an upper bound - we know the product sold fewer
 * than 100, not that it sold 100 - so that case stays null rather than inventing a figure that
 * would outrank a product with a real count of 90.
 */
export function parseSoldEstimate(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  const raw = str(v);
  if (!raw) return null;
  const m = raw.replace(/[\s,]/g, "").match(/^([<>]?)(\d+(?:\.\d+)?)([km]?)\+?$/i);
  if (!m) return num(raw);
  if (m[1] === "<") return null;
  const mult = m[3].toLowerCase() === "k" ? 1_000 : m[3].toLowerCase() === "m" ? 1_000_000 : 1;
  return Math.round(Number.parseFloat(m[2]) * mult);
}

function imagesOf(row: AnyRec): string[] {
  const out: string[] = [];
  for (const key of ["images", "imageUrls", "image_urls", "photos"]) {
    const v = row[key];
    if (Array.isArray(v)) for (const s of v) if (typeof s === "string" && s.startsWith("http")) out.push(s);
  }
  const single = str(pick(row, ["image", "imageUrl", "image_url", "thumbnail", "cover"]));
  if (single?.startsWith("http")) out.unshift(single);
  return [...new Set(out)];
}

/**
 * One row of a finished scrape job, pinned against a recorded MY response
 * (__fixtures__/shopee-scraper-job.json). Real keys are listed first, with the aliases kept
 * behind them because this listing is a bridge over an Apify actor whose output has moved before.
 *
 * Note what the catalog does NOT carry: no description, no stock, no category. Those stay null
 * and are the enrichment step's problem, not a mapping bug.
 */
export function mapShopeeRow(row: AnyRec, opts: { origin: string; currency: string | null; evidence: string }): RawProduct | null {
  const title = str(pick(row, ["name", "title", "productName", "product_name"]));
  if (!title) return null;

  const shopId = id(pick(row, ["shopId", "shop_id", "shopid"]));
  const itemId = id(pick(row, ["itemId", "item_id", "itemid", "productId", "product_id", "id"]));
  const price = num(pick(row, ["price", "priceMin", "price_min", "currentPrice", "salePrice"]));
  const before = num(pick(row, ["originalPrice", "priceBeforeDiscount", "price_before_discount", "compareAtPrice"]));
  const brand = str(row.brand);
  // A price range ("RM6.38 - RM12.30") only means anything when the variants differ.
  const priceMax = num(row.priceMax);
  const variations = (Array.isArray(row.variationOptions) ? row.variationOptions : []).map((v) => str(v)).filter((v): v is string => !!v);

  return {
    title,
    description: str(pick(row, ["description", "desc"])),
    price,
    currency: str(pick(row, ["currency", "currencyCode"])) ?? opts.currency,
    compareAtPrice: before && price && before > price ? before : null,
    url: str(pick(row, ["url", "link", "productUrl", "product_url"])) ?? (shopId && itemId ? `${opts.origin}/product/${shopId}/${itemId}` : null),
    images: imagesOf(row),
    externalId: shopId && itemId ? `${shopId}.${itemId}` : itemId,
    soldCount: parseSoldEstimate(pick(row, ["historicalSoldEstimated", "historicalSold", "historical_sold", "sold", "soldCount", "sold_count"])),
    rating: num(pick(row, ["rating", "ratingStar", "rating_star"])),
    ratingCount: num(pick(row, ["reviewCount", "review_count", "ratingCount", "rating_count"])),
    stock: num(pick(row, ["stock", "quantity"])),
    options: variations.length ? [{ name: "Option", values: variations }] : undefined,
    tags: brand ? [brand] : undefined,
    category: str(pick(row, ["category", "categoryName", "category_name"])),
    priceText: price != null && priceMax != null && priceMax > price ? `${price} - ${priceMax}` : null,
    via: VIA,
    evidence: opts.evidence,
    sourcePlatform: "shopee",
  };
}

/**
 * The catalog rows carry the seller's own name and location, so a shop that answers at all also
 * names itself - no extra call for the store title.
 */
export function shopFromRows(rows: AnyRec[]): { name: string | null; location: string | null } {
  for (const row of rows) {
    const name = str(pick(row, ["shopName", "shop_name"]));
    if (name) return { name, location: str(row.location) };
  }
  return { name: null, location: null };
}

/** Products can arrive under any of these keys, at the top level or nested under `data`/`result`. */
function rowsOf(body: AnyRec): AnyRec[] {
  const containers = [body, body.data as AnyRec, body.result as AnyRec, body.job as AnyRec].filter((c): c is AnyRec => !!c && typeof c === "object");
  for (const c of containers) {
    for (const key of ["products", "items", "results", "data"]) {
      const v = c[key];
      if (Array.isArray(v) && v.every((r) => r && typeof r === "object")) return v as AnyRec[];
    }
  }
  return [];
}

export type JobState = "running" | "done" | "failed" | "quota" | "error";

export interface JobEnvelope {
  state: JobState;
  jobId: string | null;
  /** How long to wait before the next poll, already clamped. */
  pollAfterMs: number;
  rows: AnyRec[];
  message: string | null;
}

const DONE = /^(done|completed|complete|finished|success|succeeded|ok)$/i;
const FAILED = /^(failed|error|cancelled|canceled|timeout)$/i;

/** Read a submit or poll response into a single job state. Never throws: callers log and move on. */
export function interpretJob(status: number, body: AnyRec | null, error: string | null): JobEnvelope {
  const message = str(body?.message) ?? str(body?.error) ?? error;
  const base = { jobId: null, pollAfterMs: MIN_POLL_MS, rows: [], message };
  if (status === 429 || /quota|rate limit/i.test(message ?? "")) return { ...base, state: "quota" };
  if (status === 401 || status === 403) return { ...base, state: "error", message: message ?? `HTTP ${status} (check RAPIDAPI_KEY / subscription)` };
  if (!body || status >= 400) return { ...base, state: "error", message: message ?? `HTTP ${status}` };

  const jobId = str(pick(body, ["jobId", "job_id", "id"])) ?? str(pick((body.data as AnyRec) ?? {}, ["jobId", "job_id", "id"]));
  const suggested = num(pick(body, ["pollAfterSeconds", "poll_after_seconds", "retryAfter"]));
  const pollAfterMs = Math.min(MAX_POLL_MS, Math.max(MIN_POLL_MS, (suggested ?? 0) * 1000 || MIN_POLL_MS));
  const rawState = str(pick(body, ["status", "state"])) ?? "";
  const rows = rowsOf(body);

  if (FAILED.test(rawState) || body.success === false) return { ...base, state: "failed", jobId, message: message ?? rawState };
  // Some builds answer the submit synchronously with the rows already attached; take them and stop.
  if (rows.length || DONE.test(rawState)) return { state: "done", jobId, pollAfterMs, rows, message };
  if (jobId) return { state: "running", jobId, pollAfterMs, rows: [], message };
  return { ...base, state: "error", message: message ?? "no jobId and no products in response" };
}

/** The API's country enum, from the marketplace domain. Null when Shopee runs there but the API does not. */
export function countryFor(region: string | null): string | null {
  const up = (region ?? "").toUpperCase();
  return SHOPEE_SCRAPER_COUNTRIES.includes(up) ? up : null;
}

/**
 * The shop URL to scrape, or null when we cannot build one the API accepts.
 *
 * Measured, not assumed: `shopee.com.my/<username>` returns that seller's products, while
 * `shopee.com.my/shop/<shopId>` finishes cleanly with `count: 0, "No results matched."`. A product
 * link carries only the numeric shop id, never the username, so there is no way to reach the
 * seller's catalog from one - the caller records that rather than paying for a call that cannot work.
 */
export function shopUrlFor(src: { url: string; kind: string; handle: string | null }): string | null {
  if (src.kind !== "shop") return null;
  // A shop link is already the username form; anything else (e.g. /shop/<id>) the API will not take.
  return /\/shop\/\d+\/?$/.test(new URL(src.url).pathname) ? null : src.url;
}

// ---------------------------------------------------------------------------------------------
// HTTP client
// ---------------------------------------------------------------------------------------------

export class ShopeeScraperApi {
  calls = 0;
  constructor(private readonly key: string, private readonly opts: { timeoutMs: number; signal?: AbortSignal; host?: string }) {}

  async get(path: string, params: Record<string, string | number | null | undefined> = {}): Promise<JobEnvelope> {
    const host = this.opts.host ?? SHOPEE_SCRAPER_HOST;
    const qs = Object.entries(params)
      .filter(([, v]) => v != null && v !== "")
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
      .join("&");
    this.calls += 1;
    const res = await fetchJson<AnyRec>(`https://${host}${path}${qs ? `?${qs}` : ""}`, {
      timeoutMs: this.opts.timeoutMs,
      signal: this.opts.signal,
      retries: 0,
      headers: { "x-rapidapi-key": this.key, "x-rapidapi-host": host },
    });
    return interpretJob(res.status, res.data, res.error);
  }
}

export interface ScrapeOptions {
  deadline: number;
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  signal?: AbortSignal;
}

/**
 * Submit a scrape and poll until it finishes or the budget runs out. Returns the rows found and
 * the final state, so the caller can tell "no products" apart from "ran out of time".
 */
export async function scrape(api: ShopeeScraperApi, params: Record<string, string | number | null>, opts: ScrapeOptions): Promise<JobEnvelope> {
  let env = await api.get("/shopee", params);
  if (env.state !== "running" || !env.jobId) return env;

  while (Date.now() < opts.deadline) {
    const wait = Math.min(env.pollAfterMs, Math.max(0, opts.deadline - Date.now()));
    await opts.sleep(wait, opts.signal);
    if (opts.signal?.aborted) break;
    if (Date.now() >= opts.deadline) break;
    const poll = await api.get(`/jobs/${env.jobId}`);
    if (poll.state !== "running") return poll;
    env = { ...poll, jobId: poll.jobId ?? env.jobId };
  }
  return { ...env, state: "failed", message: `job ${env.jobId} still running after ${Math.round((opts.deadline - Date.now()) / 1000)}s budget` };
}

// ---------------------------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------------------------

function applyRows(signals: SourceSignals, rows: AnyRec[], opts: { origin: string; currency: string | null; evidence: string; max: number }): number {
  let added = 0;
  for (const row of rows) {
    if (signals.products.length >= opts.max) break;
    const p = mapShopeeRow(row, opts);
    if (!p) continue;
    if (p.externalId && signals.products.some((x) => x.externalId === p.externalId)) continue;
    signals.products.push(p);
    added += 1;
    if (p.images?.[0]) mergeUnique(signals.images, [p.images[0]]);
  }
  return added;
}

export function makeShopeeScraperProvider(overrides: { host?: string; sleep?: ScrapeOptions["sleep"] } = {}): Provider {
  const nap = overrides.sleep ?? sleep;
  return {
    id: VIA,
    // Fallback stage, ahead of the readers (45-50): when Shopee's own endpoints came up empty this
    // is a better use of the next 30 seconds than rendering the page.
    priority: 40,
    stage: "fallback",
    supports(src, ctx: ProviderContext) {
      if (!ctx.config.rapidApiKey) return false;
      if (src.platform !== "shopee") return false;
      // shp.ee short links carry no marketplace and no ids; nothing to hand the API.
      if (new URL(src.url).hostname.replace(/^www\./, "") === "shp.ee") return false;
      return src.kind === "shop" || src.kind === "product";
    },
    async run(src, signals, ctx: ProviderContext) {
      if (!isThinSource(signals)) return;

      const country = countryFor(src.region);
      if (!country) {
        signals.errors.push(`${VIA}: ${src.region ? `Shopee ${src.region.toUpperCase()}` : "this marketplace"} is outside the API's countries (${SHOPEE_SCRAPER_COUNTRIES.join(", ")})`);
        return;
      }
      const shopUrl = shopUrlFor(src);
      if (!shopUrl) {
        // Worth being specific: this is a limit of the API, not a parsing failure, and the fix is
        // for the merchant to paste their shop link rather than a product link.
        signals.errors.push(
          src.kind === "product"
            ? `${VIA}: a product link carries only the numeric shop id, and the API only accepts a shopee.com/<username> shop URL — paste the shop link instead`
            : `${VIA}: ${src.url} is not a username-form shop URL the API accepts`,
        );
        return;
      }

      const config: EngineConfig = ctx.config;
      // Measured: the submit call itself can take ~47s before it hands back a jobId, so this
      // socket timeout is deliberately far above the engine-wide fetch timeout.
      const api = new ShopeeScraperApi(config.rapidApiKey!, { timeoutMs: Math.max(config.fetchTimeoutMs, 90_000), signal: ctx.signal, host: overrides.host });
      const before = signals.products.length;
      const maxItems = Math.min(MAX_ITEMS_CAP, Math.max(1, config.maxProducts - before));
      const deadline = Date.now() + config.shopeeScraperTimeoutMs;

      try {
        const env = await scrape(api, { shopUrl, country, maxItems, priceSlicing: "false" }, { deadline, sleep: nap, signal: ctx.signal });
        if (env.state === "quota") {
          signals.errors.push(`${VIA}: RapidAPI quota exhausted — ${env.message ?? "429"}`);
          return;
        }
        if (env.state !== "done") {
          signals.errors.push(`${VIA}: ${env.message ?? env.state}`);
          return;
        }
        const origin = new URL(src.url).origin;
        const added = applyRows(signals, env.rows, { origin, currency: signals.products[0]?.currency ?? null, evidence: shopUrl, max: config.maxProducts });
        if (!added) {
          signals.errors.push(`${VIA}: job returned ${env.rows.length} row(s), none usable`);
          return;
        }
        const shop = shopFromRows(env.rows);
        if (shop.name) {
          signals.profile = signals.profile ?? { name: null, handle: null, bio: null, avatar: null, followers: null, verified: null, website: null };
          signals.profile.name = signals.profile.name ?? shop.name;
          signals.profile.location = signals.profile.location ?? shop.location ?? undefined;
          signals.title = signals.title ?? shop.name;
          signals.siteName = signals.siteName ?? shop.name;
        }
        signals.embedded.shopeeScraper = { country, shopUrl, requested: maxItems, returned: env.rows.length, shopName: shop.name };
        signals.status = "ok";
        signals.canonicalUrl = signals.canonicalUrl ?? shopUrl;
      } finally {
        signals.embedded.shopeeScraperCalls = ((signals.embedded.shopeeScraperCalls as number | undefined) ?? 0) + api.calls;
        ctx.log.debug(`${VIA}: ${api.calls} request(s), ${signals.products.length - before} new products`, { url: src.url, country });
      }
    },
  };
}

export const shopeeScraperProvider: Provider = makeShopeeScraperProvider();
