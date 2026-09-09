/**
 * TikTok Shop via RapidAPI ("TikTok Shop API - Product Search, Seller Data, Reviews" by API Burst).
 *
 * TikTok Shop never renders its catalog to bots, so this is the one strategy that returns the
 * merchant's real listings (title, price, photo, rating, sold count, variants, stock) from a link.
 * Every request costs one credit on the RapidAPI plan, so the provider is careful:
 *
 *   store link    -> /shop/products (20 per page, up to NEXOVA_TIKTOK_SHOP_MAX_PAGES pages)
 *                    then /shop/product for the first NEXOVA_TIKTOK_SHOP_DETAILS products
 *                    (description, all photos, variants, stock, plus the seller profile)
 *   product link  -> /shop/product for that product (also yields seller id + profile),
 *                    then the seller's catalog as above
 *   @profile link -> /shop/showcase (the creator's showcase; may include affiliate products)
 *
 * The API needs a region. We try the region found in the URL first, then NEXOVA_TIKTOK_SHOP_REGIONS
 * in order, stopping at the first that knows the shop. A quota error stops immediately.
 */
import type { EngineConfig } from "../../config.js";
import type { RawProduct, RawProfile, SourceSignals } from "../../schema/signals.js";
import { fetchJson } from "../http.js";
import { mapLimit } from "../../util/retry.js";
import { mergeUnique, type Provider, type ProviderContext } from "./types.js";

type AnyRec = Record<string, unknown>;

export const TIKTOK_SHOP_API_HOST = "tiktok-shop-api-product-search-seller-data-reviews.p.rapidapi.com";
export const TIKTOK_SHOP_REGIONS = ["US", "GB", "DE", "FR", "IT", "ID", "MY", "MX", "PH", "SG", "ES", "TH", "VN", "BR", "JP", "IE"];
/** Detail fetches in flight at once. Small: each one is a paid API credit. */
const DETAIL_CONCURRENCY = 4;

const VIA = "tiktok-shop-api";
const VIA_SHOWCASE = "tiktok-shop-api-showcase";

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

function firstUrl(img: unknown): string | null {
  if (!img || typeof img !== "object") return null;
  const list = (img as AnyRec).url_list;
  if (Array.isArray(list) && typeof list[0] === "string") return list[0];
  return str((img as AnyRec).url);
}

export function productUrl(productId: string, region: string | null): string {
  return `https://www.tiktok.com/view/product/${productId}${region ? `?region=${region.toUpperCase()}` : ""}`;
}

export function storeUrl(shopId: string): string {
  return `https://www.tiktok.com/shop/store/${shopId}`;
}

/** One row of /shop/products or /shop/showcase. */
export function mapListProduct(row: AnyRec, opts: { region: string | null; via?: string; evidence: string }): RawProduct | null {
  const id = str(row.product_id) ?? str(row.id);
  const title = str(row.title) ?? str(row.name);
  if (!title) return null;
  const image = str(row.image_url) ?? firstUrl(row.image);
  return {
    title,
    description: str(row.description),
    price: num(row.price),
    currency: str(row.currency),
    url: id ? productUrl(id, opts.region) : null,
    images: image ? [image] : [],
    externalId: id,
    soldCount: num(row.sold_count),
    rating: num(row.rating),
    ratingCount: num(row.review_count),
    stock: typeof row.stock_quantity === "number" ? row.stock_quantity : row.in_stock === false ? 0 : null,
    via: opts.via ?? VIA,
    evidence: opts.evidence,
    sourcePlatform: "tiktok_shop",
  };
}

/** Flatten TikTok's rich-text description blocks into plain paragraphs (+ the banner images). */
export function flattenRichDescription(desc: unknown): { text: string; images: string[] } {
  const blocks = ((desc as AnyRec | undefined)?.ec_rich_blocks as AnyRec[] | undefined) ?? [];
  const paragraphs: string[] = [];
  const images: string[] = [];
  for (const block of blocks) {
    const rich = block.xl_ec_rich_text as AnyRec | undefined;
    const texts = (rich?.ec_rich_texts as AnyRec[] | undefined) ?? [];
    for (const t of texts) {
      const args = (t.arguments as Record<string, AnyRec> | undefined) ?? {};
      let line = str(t.template) ?? "";
      for (const [key, arg] of Object.entries(args)) {
        const raw = (arg.text_attribute as AnyRec | undefined)?.text;
        const piece = typeof raw === "string" ? raw : "";
        line = line.split(key).join(piece);
      }
      line = line.replace(/\{\{[^}]+\}\}/g, "").trim();
      if (line) paragraphs.push(line);
    }
    const img = firstUrl(block.image);
    if (img) images.push(img);
  }
  return { text: paragraphs.join("\n"), images };
}

export interface TikTokShopReview {
  author: string | null;
  rating: number | null;
  text: string;
  source: string | null;
}

export interface TikTokShopDetail {
  product: RawProduct;
  profile: RawProfile;
  shopId: string | null;
  region: string | null;
  descriptionImages: string[];
  reviews: TikTokShopReview[];
  stats: Record<string, number | string | null>;
}

/** The /shop/product payload: one rich product plus everything we can learn about the seller. */
export function mapProductDetail(data: AnyRec, opts: { region: string | null; evidence: string }): TikTokShopDetail | null {
  const base = (data.product_base ?? {}) as AnyRec;
  const title = str(base.title);
  const id = str(data.product_id);
  if (!title || !id) return null;

  const price = (base.price ?? {}) as AnyRec;
  const skus = (data.skus as AnyRec[] | undefined) ?? [];
  const saleProps = (data.sale_props as AnyRec[] | undefined) ?? [];
  const review = (data.product_detail_review ?? {}) as AnyRec;
  const seller = (data.seller ?? {}) as AnyRec;
  const sellerUser = (seller.seller_user_info ?? {}) as AnyRec;

  const deepLink = str((data.share_info as AnyRec | undefined)?.share_deep_link) ?? "";
  const regionFromLink = deepLink.match(/shop\.tiktok\.com\/([a-z]{2})\//i)?.[1]?.toUpperCase() ?? null;
  const region = opts.region ?? str(sellerUser.region) ?? regionFromLink;

  const images = ((base.images as AnyRec[] | undefined) ?? []).map(firstUrl).filter((u): u is string => !!u);
  const { text: descText, images: descImages } = flattenRichDescription(base.desc_detailv3);
  const specs = ((base.specifications as AnyRec[] | undefined) ?? []).map((s) => (str(s.name) && str(s.value) ? `${str(s.name)}: ${str(s.value)}` : null)).filter(Boolean) as string[];
  const description = [descText, specs.length ? `Specifications\n${specs.join("\n")}` : ""].filter(Boolean).join("\n\n") || null;

  const salePrice = num(price.min_sku_price) ?? num(price.real_price) ?? num(skus[0] && ((skus[0].price as AnyRec | undefined)?.real_price as AnyRec | undefined)?.price_val);
  const originalPrice = num(price.min_sku_original_price) ?? num(price.original_price);
  const currency = str(price.currency) ?? str(((skus[0]?.price as AnyRec | undefined)?.real_price as AnyRec | undefined)?.currency);

  const variants = skus
    .map((sku) => {
      const props = ((sku.sku_sale_props as AnyRec[] | undefined) ?? []).map((p) => str(p.prop_value)).filter(Boolean) as string[];
      const p = (sku.price ?? {}) as AnyRec;
      return { title: props.join(" / ") || "Default", price: num((p.real_price as AnyRec | undefined)?.price_val), sku: str(sku.sku_id), image: null, stock: typeof sku.stock === "number" ? sku.stock : null };
    })
    .filter((v) => v.title !== "Default" || skus.length === 1);
  const options = saleProps
    .map((p) => ({ name: str(p.prop_name) ?? "Option", values: ((p.sale_prop_values as AnyRec[] | undefined) ?? []).map((v) => str(v.prop_value)).filter(Boolean) as string[] }))
    .filter((o) => o.values.length);
  const stocks = skus.map((s) => (typeof s.stock === "number" ? s.stock : null)).filter((s): s is number => s !== null);
  const brand = specs.find((s) => /^brand:/i.test(s))?.replace(/^brand:\s*/i, "") ?? null;

  const product: RawProduct = {
    title,
    description,
    price: salePrice,
    currency,
    compareAtPrice: originalPrice && salePrice && originalPrice > salePrice ? originalPrice : null,
    url: productUrl(id, region),
    images,
    externalId: id,
    soldCount: num(base.sold_count),
    rating: num(review.product_rating),
    ratingCount: num(review.review_count),
    stock: stocks.length ? stocks.reduce((a, b) => a + b, 0) : null,
    variants: variants.length > 1 ? variants : undefined,
    options: options.length ? options : undefined,
    tags: brand ? [brand] : undefined,
    category: str(base.category_name),
    via: VIA,
    evidence: opts.evidence,
    sourcePlatform: "tiktok_shop",
  };

  const details = ((seller.seller_detail_infos as AnyRec[] | undefined) ?? []).reduce<Record<string, number>>((acc, d) => {
    if (typeof d.key === "string" && typeof d.count === "number") acc[d.key] = d.count;
    return acc;
  }, {});
  const official = !!((seller.store_label as AnyRec | undefined)?.official_label) || /blue_v/i.test(JSON.stringify((data.brand_info as AnyRec | undefined)?.brand_labels ?? ""));
  const profile: RawProfile = {
    name: str(seller.name) ?? str(sellerUser.nickname),
    handle: null,
    bio: null,
    avatar: firstUrl(seller.avatar),
    followers: num(sellerUser.follower_count) ?? details.followers_num ?? null,
    verified: official || null,
    website: null,
    location: str(seller.seller_location),
  };
  const shopId = str(seller.seller_id) ?? str(data.seller_id);
  const reviews: TikTokShopReview[] = ((review.review_items as AnyRec[] | undefined) ?? [])
    .filter((item) => !!str((item.review as AnyRec | undefined)?.display_text))
    .slice(0, 6)
    .map((item) => {
      const r = item.review as AnyRec;
      const user = (item.review_user ?? {}) as AnyRec;
      const anonymous = item.is_anonymous === true;
      return { author: anonymous ? null : str(user.name), rating: num(r.rating), text: str(r.display_text)!, source: str(item.review_source_name) ?? "TikTok Shop" };
    });
  const stats: TikTokShopDetail["stats"] = {
    shopRating: num(seller.rating),
    productCount: num(seller.product_count) ?? details.items_num ?? null,
    soldCount: details.sales_num ?? null,
    reviewCount: details.review_num ?? null,
    responseRate: details.response_rate ?? null,
    followers: profile.followers,
    location: profile.location ?? null,
    background: firstUrl((seller.shop_background as AnyRec | undefined)?.image),
  };
  return { product, profile, shopId, region, descriptionImages: descImages, reviews, stats };
}

/** Normalize a handle or shop name for matching: lowercase, letters and digits only. */
function normalizeName(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

const HANDLE_SUFFIXES = /(\.|_|-)?(my|sg|id|ph|th|vn|official|hq|store|shop|olshop|global)$/i;

/** Search queries worth one credit each for a handle: the handle itself, then the handle without a market/official suffix. */
export function searchQueriesForHandle(handle: string): string[] {
  const base = handle.replace(/^@/, "").trim();
  const stripped = base.replace(HANDLE_SUFFIXES, "").replace(/[._-]+$/, "");
  const out = [base];
  if (stripped && stripped.length >= 3 && normalizeName(stripped) !== normalizeName(base)) out.push(stripped);
  return out;
}

/** Pick the shop in search results whose name is the merchant's handle (exactly, or minus a suffix on either side). */
export function matchShopByHandle(rows: AnyRec[], handle: string): { shopId: string; shopName: string } | null {
  const target = normalizeName(handle.replace(/^@/, ""));
  const targetStripped = normalizeName(handle.replace(/^@/, "").replace(HANDLE_SUFFIXES, ""));
  const shops = new Map<string, { shopId: string; shopName: string; hits: number }>();
  for (const row of rows) {
    const id = str(row.shop_id);
    const name = str(row.shop_name);
    if (!id || !name) continue;
    const entry = shops.get(id) ?? { shopId: id, shopName: name, hits: 0 };
    entry.hits += 1;
    shops.set(id, entry);
  }
  const ranked = [...shops.values()].sort((a, b) => b.hits - a.hits);
  const exact = ranked.find((s) => normalizeName(s.shopName) === target);
  if (exact) return { shopId: exact.shopId, shopName: exact.shopName };
  if (targetStripped.length >= 3) {
    const loose = ranked.find((s) => normalizeName(s.shopName.replace(HANDLE_SUFFIXES, "")) === targetStripped);
    if (loose) return { shopId: loose.shopId, shopName: loose.shopName };
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// HTTP client
// ---------------------------------------------------------------------------------------------

export interface ApiEnvelope<T> {
  ok: boolean;
  data: T | null;
  /** "not_found" means the region does not know this shop/product; "quota" is a hard stop. */
  reason: "ok" | "not_found" | "quota" | "error";
  message: string | null;
  hasMore: boolean;
  cursor: string | null;
}

export class TikTokShopApi {
  calls = 0;
  constructor(private readonly key: string, private readonly opts: { timeoutMs: number; signal?: AbortSignal; host?: string }) {}

  async get<T>(path: string, params: Record<string, string | null | undefined>): Promise<ApiEnvelope<T>> {
    const host = this.opts.host ?? TIKTOK_SHOP_API_HOST;
    const qs = Object.entries(params)
      .filter(([, v]) => v != null && v !== "")
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v!)}`)
      .join("&");
    this.calls += 1;
    const res = await fetchJson<AnyRec>(`https://${host}${path}?${qs}`, { timeoutMs: this.opts.timeoutMs, signal: this.opts.signal, retries: 0, headers: { "x-rapidapi-key": this.key, "x-rapidapi-host": host } });
    return interpretEnvelope<T>(res.status, res.data, res.error);
  }
}

export function interpretEnvelope<T>(status: number, body: AnyRec | null, error: string | null): ApiEnvelope<T> {
  const message = str(body?.message) ?? error;
  if (status === 429 || /quota|rate limit/i.test(message ?? "")) return { ok: false, data: null, reason: "quota", message, hasMore: false, cursor: null };
  if (status === 401 || status === 403) return { ok: false, data: null, reason: "error", message: message ?? `HTTP ${status} (check RAPIDAPI_KEY / subscription)`, hasMore: false, cursor: null };
  if (!body || status >= 400) return { ok: false, data: null, reason: "error", message: message ?? `HTTP ${status}`, hasMore: false, cursor: null };
  const data = body.data as T | null | undefined;
  const empty = data == null || (Array.isArray(data) && data.length === 0);
  if (body.success === false || (empty && /not found|unavailable/i.test(message ?? ""))) return { ok: false, data: null, reason: "not_found", message, hasMore: false, cursor: null };
  const pagination = (body.pagination ?? {}) as AnyRec;
  return { ok: true, data: (data ?? null) as T | null, reason: "ok", message, hasMore: pagination.has_more === true, cursor: str(pagination.cursor) };
}

/** Regions to try, most likely first, without repeats. */
export function regionCandidates(urlRegion: string | null, configured: string[]): string[] {
  const out: string[] = [];
  for (const r of [urlRegion, ...configured]) {
    const up = (r ?? "").toUpperCase();
    if (up && TIKTOK_SHOP_REGIONS.includes(up) && !out.includes(up)) out.push(up);
  }
  return out.length ? out : ["US"];
}

// ---------------------------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------------------------

function ensureProfile(signals: SourceSignals): RawProfile {
  signals.profile = signals.profile ?? { name: null, handle: null, bio: null, avatar: null, followers: null, verified: null, website: null };
  return signals.profile;
}

function applyProfile(signals: SourceSignals, incoming: RawProfile): void {
  const p = ensureProfile(signals);
  p.name = p.name ?? incoming.name;
  p.avatar = p.avatar ?? incoming.avatar;
  p.followers = p.followers ?? incoming.followers;
  p.verified = p.verified ?? incoming.verified;
  p.location = p.location ?? incoming.location ?? undefined;
  if (incoming.avatar) mergeUnique(signals.images, [incoming.avatar]);
  if (!signals.title && incoming.name) signals.title = incoming.name;
  if (!signals.siteName && incoming.name) signals.siteName = incoming.name;
}

function applyDetail(signals: SourceSignals, detail: TikTokShopDetail): void {
  const existing = signals.products.find((p) => p.externalId && p.externalId === detail.product.externalId);
  if (existing) {
    existing.description = existing.description || detail.product.description;
    existing.images = [...new Set([...(detail.product.images ?? []), ...(existing.images ?? [])])];
    existing.price = detail.product.price ?? existing.price;
    existing.currency = detail.product.currency ?? existing.currency;
    existing.compareAtPrice = detail.product.compareAtPrice ?? existing.compareAtPrice;
    existing.variants = detail.product.variants ?? existing.variants;
    existing.options = detail.product.options ?? existing.options;
    existing.stock = detail.product.stock ?? existing.stock;
    existing.soldCount = detail.product.soldCount ?? existing.soldCount;
    existing.rating = detail.product.rating ?? existing.rating;
    existing.ratingCount = detail.product.ratingCount ?? existing.ratingCount;
    existing.category = detail.product.category ?? existing.category;
    existing.tags = detail.product.tags ?? existing.tags;
    existing.url = detail.product.url ?? existing.url;
  } else signals.products.push(detail.product);
  applyProfile(signals, detail.profile);
  // Product photos are hero candidates; description banners are marketing collages with baked-in text, so they stay out of the pool.
  mergeUnique(signals.images, detail.product.images ?? []);
  if (typeof detail.stats.background === "string") mergeUnique(signals.images, [detail.stats.background]);
  const shop = (signals.embedded.tiktokShop as AnyRec | undefined) ?? {};
  signals.embedded.tiktokShop = { ...shop, ...Object.fromEntries(Object.entries(detail.stats).filter(([, v]) => v != null)), shopId: detail.shopId ?? shop.shopId ?? null, region: detail.region ?? shop.region ?? null };
  if (detail.reviews.length) {
    const prev = (signals.embedded.tiktokShopReviews as TikTokShopReview[] | undefined) ?? [];
    const seen = new Set(prev.map((r) => r.text));
    signals.embedded.tiktokShopReviews = [...prev, ...detail.reviews.filter((r) => !seen.has(r.text))].slice(0, 12);
  }
}

interface RunState {
  api: TikTokShopApi;
  config: EngineConfig;
  signals: SourceSignals;
  regions: string[];
  /** Locked once any call succeeds, so later calls never pay for region probing again. */
  region: string | null;
  stopped: boolean;
}

/** Try each candidate region until one answers; lock it for the rest of the run. */
async function withRegion<T>(state: RunState, label: string, call: (region: string) => Promise<ApiEnvelope<T>>): Promise<ApiEnvelope<T> | null> {
  if (state.stopped) return null;
  const regions = state.region ? [state.region] : state.regions;
  let last: ApiEnvelope<T> | null = null;
  for (const region of regions) {
    const res = await call(region);
    last = res;
    if (res.ok) {
      state.region = region;
      return res;
    }
    if (res.reason === "quota") {
      state.stopped = true;
      state.signals.errors.push(`${VIA}(${label}): RapidAPI quota exhausted — ${res.message ?? "429"}`);
      return null;
    }
    if (res.reason !== "not_found") {
      state.signals.errors.push(`${VIA}(${label}): ${res.message ?? "request failed"}`);
      return null;
    }
  }
  state.signals.errors.push(`${VIA}(${label}): not found in region${regions.length > 1 ? "s" : ""} ${regions.join(", ")}${last?.message ? ` (${last.message})` : ""}`);
  return null;
}

async function fetchCatalog(state: RunState, ident: { shopId: string | null; url: string | null }): Promise<number> {
  const { config, signals } = state;
  const maxPages = config.tiktokShopMaxPages;
  let cursor: string | null = null;
  let added = 0;
  for (let page = 1; page <= maxPages; page++) {
    const res: ApiEnvelope<AnyRec[]> | null = await withRegion<AnyRec[]>(state, page === 1 ? "catalog" : `catalog p${page}`, (region) => state.api.get<AnyRec[]>("/shop/products", { region, shop_id: ident.shopId, url: ident.shopId ? null : ident.url, cursor }));
    if (!res) break;
    const rows = res.data ?? [];
    const evidence = ident.shopId ? storeUrl(ident.shopId) : (ident.url ?? signals.url);
    for (const row of rows) {
      const p = mapListProduct(row, { region: state.region, evidence });
      if (!p) continue;
      if (signals.products.some((x) => x.externalId && x.externalId === p.externalId)) continue;
      signals.products.push(p);
      added += 1;
      if (p.images?.[0]) mergeUnique(signals.images, [p.images[0]]);
    }
    const shopId = str(rows[0]?.shop_id);
    if (shopId && !ident.shopId) ident.shopId = shopId;
    if (rows[0] && str(rows[0].shop_name)) ensureProfile(signals).name = signals.profile!.name ?? str(rows[0].shop_name);
    if (!res.hasMore || !res.cursor || signals.products.length >= config.maxProducts) break;
    cursor = res.cursor;
  }
  if (ident.shopId) signals.embedded.tiktokShop = { ...((signals.embedded.tiktokShop as AnyRec | undefined) ?? {}), shopId: ident.shopId, region: state.region };
  return added;
}

async function fetchDetail(state: RunState, ident: { productId: string | null; url: string | null }): Promise<TikTokShopDetail | null> {
  const res = await withRegion<AnyRec>(state, `product ${ident.productId ?? ""}`.trim(), (region) => state.api.get<AnyRec>("/shop/product", { region, product_id: ident.productId, url: ident.productId ? null : ident.url }));
  if (!res?.data) return null;
  const detail = mapProductDetail(res.data, { region: state.region, evidence: ident.productId ? productUrl(ident.productId, state.region) : (ident.url ?? state.signals.url) });
  if (!detail) {
    state.signals.errors.push(`${VIA}(product): unexpected payload`);
    return null;
  }
  applyDetail(state.signals, detail);
  return detail;
}

/** Enrich the first N catalog rows with full details (photos, description, variants) and the seller profile. */
async function enrichTop(state: RunState, skip: Set<string>): Promise<void> {
  const budget = state.config.tiktokShopDetails;
  if (budget <= 0) return;
  const targets = state.signals.products.filter((p) => p.via === VIA && p.externalId && !skip.has(p.externalId)).slice(0, budget);
  // Each detail is an independent GET and applyDetail only touches its own product row, so these
  // go out together. Serially they were ~6s each and dominated ingest. The credit cost is the
  // same either way; `stopped` is still checked per task so a quota error stops the rest.
  await mapLimit(targets, DETAIL_CONCURRENCY, async (p) => {
    if (state.stopped) return;
    const d = await fetchDetail(state, { productId: p.externalId!, url: null });
    if (d) skip.add(p.externalId!);
  });
}

/**
 * The API does not index every product id, and a pasted profile carries no shop id at all. Searching
 * the handle finds the shop by name; its id then gives the full catalog.
 */
async function searchShopByHandle(state: RunState, handle: string): Promise<boolean> {
  for (const query of searchQueriesForHandle(handle)) {
    if (state.stopped) return false;
    const res = await withRegion<AnyRec[]>(state, `search "${query}"`, (region) => state.api.get<AnyRec[]>("/shop/search", { region, query, page: "1" }));
    if (!res) continue;
    const match = matchShopByHandle(res.data ?? [], handle);
    if (!match) {
      state.signals.errors.push(`${VIA}(search "${query}"): ${res.data?.length ?? 0} results, none from a shop named like @${handle}`);
      continue;
    }
    // A wrong match would put another merchant's catalog on this store; drop the error trail for the found shop.
    state.signals.errors = state.signals.errors.filter((e) => !e.startsWith(`${VIA}(search`));
    ensureProfile(state.signals).name = state.signals.profile!.name ?? match.shopName;
    const added = await fetchCatalog(state, { shopId: match.shopId, url: null });
    if (added > 0) {
      await enrichTop(state, new Set());
      return true;
    }
  }
  return false;
}

export function makeTikTokShopApiProvider(overrides: { host?: string } = {}): Provider {
  return {
    id: VIA,
    priority: 5,
    stage: "always",
    supports(src, ctx) {
      if (!ctx.config.rapidApiKey) return false;
      if (src.platform === "tiktok_shop") return src.kind === "shop" || src.kind === "product";
      return src.platform === "tiktok" && src.kind === "profile" && !!src.handle;
    },
    async run(src, signals, ctx: ProviderContext) {
      const api = new TikTokShopApi(ctx.config.rapidApiKey!, { timeoutMs: Math.max(ctx.config.fetchTimeoutMs, 30_000), signal: ctx.signal, host: overrides.host });
      const state: RunState = { api, config: ctx.config, signals, regions: regionCandidates(src.region, ctx.config.tiktokShopRegions), region: null, stopped: false };
      const before = signals.products.length;
      try {
        if (src.platform === "tiktok" && src.kind === "profile") {
          const res = await withRegion<AnyRec[]>(state, "showcase", (region) => api.get<AnyRec[]>("/shop/showcase", { region, handle: src.handle }));
          const rows = res?.data ?? [];
          for (const row of rows) {
            const p = mapListProduct(row, { region: state.region, via: VIA_SHOWCASE, evidence: src.url });
            if (!p || signals.products.some((x) => x.externalId && x.externalId === p.externalId)) continue;
            p.notes = ["from the creator's TikTok showcase; may include affiliate products from other sellers"];
            signals.products.push(p);
            if (p.images?.[0]) mergeUnique(signals.images, [p.images[0]]);
          }
          if (rows.length) signals.embedded.tiktokShowcase = { count: rows.length, region: state.region };
          // The showcase is thin or empty for most sellers; their shop is found by name instead.
          if (signals.products.length < 3 && !state.stopped) await searchShopByHandle(state, src.handle!);
        } else if (src.kind === "product") {
          const productId = src.externalId && /^\d+$/.test(src.externalId) ? src.externalId : null;
          const detail = await fetchDetail(state, { productId, url: productId ? null : src.url });
          if (detail?.shopId && !state.stopped) {
            const added = await fetchCatalog(state, { shopId: detail.shopId, url: null });
            ctx.log.debug(`${VIA}: seller catalog +${added} products`, { url: src.url });
            await enrichTop(state, new Set([detail.product.externalId!]));
          }
        } else {
          const shopId = src.externalId && /^\d+$/.test(src.externalId) ? src.externalId : null;
          const added = await fetchCatalog(state, { shopId, url: shopId ? null : src.url });
          if (added > 0) await enrichTop(state, new Set());
          else if (src.handle && !state.stopped) await searchShopByHandle(state, src.handle);
        }
      } finally {
        signals.embedded.tiktokShopApiCalls = ((signals.embedded.tiktokShopApiCalls as number | undefined) ?? 0) + api.calls;
        ctx.log.debug(`${VIA}: ${api.calls} request(s), ${signals.products.length - before} new products`, { url: src.url, region: state.region });
      }
      if (signals.products.length > before || signals.profile?.name) {
        signals.status = "ok";
        if (src.platform === "tiktok_shop") signals.canonicalUrl = signals.canonicalUrl ?? (str((signals.embedded.tiktokShop as AnyRec | undefined)?.shopId) ? storeUrl(str((signals.embedded.tiktokShop as AnyRec).shopId)!) : null);
      }
    },
  };
}

export const tiktokShopApiProvider: Provider = makeTikTokShopApiProvider();
