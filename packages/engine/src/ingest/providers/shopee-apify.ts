/**
 * Shopee catalogs via the Apify actor `xtracto/shopee-scraper`.
 *
 * Shopee's own v4 endpoints (see `shopeeApiProvider` in platforms.ts) answer
 * redirect_to_error_page for most shops, so a pasted Shopee link usually yields nothing. This is
 * the paid fallback, and unlike the RapidAPI listings it is synchronous: measured against Kiehl's
 * Official Store (MY), 30 products in ~7s for about $0.15. That is fast enough to live in the
 * ingest ladder, so there is no job to poll and no second pipeline pass.
 *
 * Two limits are measured, not assumed:
 *
 *   - Shop mode returns at most 30 products, one page. Asking for 100 still returns 30, so a shop
 *     with more than 30 listings is truncated rather than paginated. Most of a small seller's
 *     catalog fits; a large brand's does not.
 *   - Since Shopee moved product pages to a client-rendered SPA in mid-2026, no scraper can reach
 *     descriptions, variants, attributes or full image galleries. One image per product is all
 *     that exists to take, so `images` is a single-element array and descriptions stay null.
 */
import type { RawProduct, SourceSignals } from "../../schema/signals.js";
import { fetchJson } from "../http.js";
import { isThinSource, mergeUnique, type Provider, type ProviderContext } from "./types.js";

type AnyRec = Record<string, unknown>;

export const SHOPEE_APIFY_ACTOR = "xtracto~shopee-scraper";
/** The actor's country enum. Wider than the RapidAPI listings: Taiwan and Colombia/Chile included. */
export const SHOPEE_APIFY_COUNTRIES = ["id", "sg", "my", "th", "ph", "vn", "br", "tw", "mx", "co", "cl"];
/** Shop mode never returns more than this, whatever maxProducts says. */
export const SHOP_PAGE_SIZE = 30;

const VIA = "shopee-apify";

// ---------------------------------------------------------------------------------------------
// Pure mappers (unit-tested against a recorded response)
// ---------------------------------------------------------------------------------------------

function num(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = Number.parseFloat(v.replace(/[^\d.]/g, ""));
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

/**
 * The actor returns HTML-escaped text: 29 of 30 rows in the recorded response carry `&#x27;`, and
 * it appears inside the product URLs too, which leaves them malformed. Decode both.
 */
export function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(Number.parseInt(dec, 10)))
    .replace(/&([a-z]+);/gi, (m, name: string) => ENTITIES[name.toLowerCase()] ?? m);
}

/**
 * `original_price` is always null in practice, but `discount_pct` is present on nearly every row,
 * so the pre-discount price is recoverable rather than lost.
 */
export function originalPriceFrom(price: number | null, discountPct: number | null): number | null {
  if (price == null || discountPct == null || discountPct <= 0 || discountPct >= 100) return null;
  return Math.round((price / (1 - discountPct / 100)) * 100) / 100;
}

/** One row of the actor's dataset. Pinned against __fixtures__/shopee-apify-shop.json. */
export function mapApifyRow(row: AnyRec, opts: { evidence: string }): RawProduct | null {
  const name = typeof row.name === "string" ? decodeEntities(row.name).trim() : "";
  if (!name) return null;
  const shopId = num(row.shop_id);
  const itemId = num(row.item_id);
  const price = num(row.price);
  const image = typeof row.image_url === "string" && row.image_url.startsWith("http") ? row.image_url : null;

  return {
    title: name,
    // Shopee serves product pages as an SPA now; there is no description to take.
    description: null,
    price,
    currency: typeof row.currency === "string" ? row.currency : null,
    compareAtPrice: originalPriceFrom(price, num(row.discount_pct)) ?? num(row.original_price),
    url: typeof row.url === "string" ? decodeEntities(row.url) : null,
    images: image ? [image] : [],
    externalId: shopId != null && itemId != null ? `${shopId}.${itemId}` : null,
    soldCount: num(row.sold_count),
    rating: num(row.rating),
    ratingCount: num(row.rating_count),
    stock: null,
    category: null,
    via: VIA,
    evidence: opts.evidence,
    sourcePlatform: "shopee",
  };
}

/** The actor's `shop` input: a username or a numeric shop id, both accepted. */
export function shopSelectorFor(src: { kind: string; handle: string | null; externalId: string | null }): string | null {
  if (src.kind === "shop") return src.handle ?? src.externalId;
  // A product link carries "<shopId>.<itemId>", and the numeric shop id alone is a valid selector -
  // so unlike the RapidAPI listing, one product link does reach the seller's catalogue.
  if (src.kind === "product" && src.externalId?.includes(".")) return src.externalId.split(".")[0];
  return null;
}

export function countryFor(region: string | null): string | null {
  const low = (region ?? "").toLowerCase();
  return SHOPEE_APIFY_COUNTRIES.includes(low) ? low : null;
}

// ---------------------------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------------------------

export function makeShopeeApifyProvider(overrides: { actor?: string; baseUrl?: string } = {}): Provider {
  const actor = overrides.actor ?? SHOPEE_APIFY_ACTOR;
  const baseUrl = overrides.baseUrl ?? "https://api.apify.com";
  return {
    id: VIA,
    // Fallback, ahead of the readers (45-50): when Shopee's own endpoints came up empty this is a
    // better use of the next ten seconds than rendering the page, but it costs money, so the free
    // strategies get their turn first.
    priority: 40,
    stage: "fallback",
    supports(src, ctx: ProviderContext) {
      if (!ctx.config.apifyToken) return false;
      if (src.platform !== "shopee") return false;
      return !!shopSelectorFor(src) && !!countryFor(src.region);
    },
    async run(src, signals, ctx: ProviderContext) {
      if (!isThinSource(signals)) return;
      const shop = shopSelectorFor(src);
      const country = countryFor(src.region);
      if (!shop || !country) return;

      const before = signals.products.length;
      const maxProducts = Math.min(SHOP_PAGE_SIZE, Math.max(1, ctx.config.maxProducts - before));
      const res = await fetchJson<AnyRec[]>(`${baseUrl}/v2/acts/${actor}/run-sync-get-dataset-items?token=${encodeURIComponent(ctx.config.apifyToken!)}`, {
        method: "POST",
        body: JSON.stringify({ country, mode: "shop", shop, maxProducts, fetchDetail: false }),
        headers: { "content-type": "application/json" },
        timeoutMs: Math.max(ctx.config.fetchTimeoutMs, 60_000),
        signal: ctx.signal,
        retries: 0,
      });

      if (!res.ok || !Array.isArray(res.data)) {
        // The token is the one failure worth naming precisely; everything else is transient.
        const why = res.status === 401 || res.status === 403 ? "APIFY_TOKEN rejected" : (res.error ?? `HTTP ${res.status}`);
        signals.errors.push(`${VIA}: ${why}`);
        return;
      }

      const evidence = `https://shopee.com.${country === "my" ? "my" : country}/${shop}`;
      let added = 0;
      for (const row of res.data) {
        if (signals.products.length >= ctx.config.maxProducts) break;
        const p = mapApifyRow(row, { evidence });
        if (!p) continue;
        if (p.externalId && signals.products.some((x) => x.externalId === p.externalId)) continue;
        signals.products.push(p);
        added += 1;
        if (p.images?.[0]) mergeUnique(signals.images, [p.images[0]]);
      }
      if (!added) {
        signals.errors.push(`${VIA}: shop "${shop}" returned ${res.data.length} row(s), none usable`);
        return;
      }

      const shopId = num(res.data[0]?.shop_id);
      const isMall = res.data.some((r) => (r as AnyRec).is_mall === true);
      if (isMall) {
        signals.profile = signals.profile ?? { name: null, handle: null, bio: null, avatar: null, followers: null, verified: null, website: null };
        signals.profile.verified = signals.profile.verified ?? true;
      }
      signals.embedded.shopeeApify = { shop, country, shopId, returned: res.data.length, truncated: res.data.length >= SHOP_PAGE_SIZE };
      signals.status = "ok";
      ctx.log.debug(`${VIA}: +${added} products`, { url: src.url, shop, country });
    },
  };
}

export const shopeeApifyProvider: Provider = makeShopeeApifyProvider();
