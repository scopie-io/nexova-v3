/**
 * Embedded-JSON hunter: platform-agnostic extraction of product-like objects from the JSON
 * blobs that modern storefronts embed in their HTML (Next.js __NEXT_DATA__, Nuxt/Vue
 * __INITIAL_STATE__, TikTok __UNIVERSAL_DATA_FOR_REHYDRATION__ / __MODERN_ROUTER_DATA__,
 * Lazada app.run(...), Shopee SEO payloads, Shopify ProductJson, generic application/json).
 * This is the same trick LLM-scraping stacks use to avoid rendering pages at all.
 */
import * as cheerio from "cheerio";
import type { RawProduct } from "../../schema/signals.js";
import { guessCurrencyFromText, parsePrice } from "../../util/text.js";

type AnyRec = Record<string, unknown>;

const NAME_KEYS = ["name", "title", "product_name", "productName", "item_name", "itemName", "product_title", "productTitle", "goods_name"];
const PRICE_KEYS = ["price", "price_min", "priceMin", "salePrice", "sale_price", "final_price", "finalPrice", "current_price", "currentPrice", "priceShow", "price_show", "min_price", "lowest_price", "skuPrice", "unit_price", "amount", "priceInfo", "price_info", "displayPrice", "pricing"];
const COMPARE_KEYS = ["price_before_discount", "compare_at_price", "compareAtPrice", "original_price", "originalPrice", "list_price", "listPrice", "priceMax", "price_max", "originalPriceShow"];
const IMAGE_KEYS = ["image", "images", "img", "cover", "thumbnail", "thumb", "imageUrl", "image_url", "mainImage", "main_image", "featured_image", "featuredImage", "pic", "picture", "photo", "photos", "media", "cover_image"];
const ID_KEYS = ["id", "product_id", "productId", "item_id", "itemId", "sku", "goods_id", "spu_id"];
const URL_KEYS = ["url", "link", "productUrl", "product_url", "href", "detail_url", "itemUrl", "path"];
const SOLD_KEYS = ["sold", "historical_sold", "sales", "sold_count", "soldCount", "sales_count", "salesCount", "total_sold", "sell_count"];
const RATING_KEYS = ["rating", "rating_star", "ratingScore", "rating_score", "average_rating", "avgRating", "star", "score"];
const STOCK_KEYS = ["stock", "quantity", "inventory_quantity", "available", "in_stock", "inStock", "stock_count"];
const DESC_KEYS = ["description", "desc", "body_html", "summary", "short_description", "product_desc"];
const VARIANT_KEYS = ["variants", "models", "skus", "sku_list", "skuList", "options", "sku_infos"];

const MAX_NODES = 60_000;

export interface HuntOptions {
  platform?: string | null;
  baseUrl?: string;
  via?: string;
  maxProducts?: number;
}

/** Extract every JSON blob embedded in the HTML (scripts + inline assignments). */
export function extractJsonBlobs(html: string): unknown[] {
  const blobs: unknown[] = [];
  const $ = cheerio.load(html);
  $("script").each((_, el) => {
    const type = ($(el).attr("type") ?? "").toLowerCase();
    const raw = $(el).contents().text();
    if (!raw || raw.length > 6_000_000) return;
    if (type === "application/json" || type === "application/ld+json" || $(el).attr("id")?.startsWith("__")) {
      const parsed = tryParse(raw);
      if (parsed !== undefined) blobs.push(parsed);
      return;
    }
    if (type && !/javascript|module/.test(type)) return;
    // window.__X__ = {...}; / var initialData = {...}; / JSON.parse("...")
    for (const m of raw.matchAll(/(?:window\.|var\s+|let\s+|const\s+|self\.)?__?[A-Za-z0-9_$]{2,60}__?\s*=\s*(\{[\s\S]{40,}?\})\s*;(?:\s|$)/g)) {
      const parsed = tryParse(m[1]);
      if (parsed !== undefined) blobs.push(parsed);
    }
    for (const m of raw.matchAll(/JSON\.parse\(\s*"((?:[^"\\]|\\.){80,})"\s*\)/g)) {
      try {
        const inner = JSON.parse(`"${m[1]}"`);
        const parsed = tryParse(inner);
        if (parsed !== undefined) blobs.push(parsed);
      } catch {
        /* ignore */
      }
    }
    for (const m of raw.matchAll(/app\.run\(\s*(\{[\s\S]{80,}?\})\s*\)\s*;?/g)) {
      const parsed = tryParse(m[1]);
      if (parsed !== undefined) blobs.push(parsed);
    }
  });
  return blobs;
}

function tryParse(raw: string): unknown {
  const s = raw.trim();
  if (!s.startsWith("{") && !s.startsWith("[")) return undefined;
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}

function pick(obj: AnyRec, keys: string[]): unknown {
  for (const k of keys) if (k in obj && obj[k] != null && obj[k] !== "") return obj[k];
  return undefined;
}

function str(v: unknown): string | null {
  if (typeof v === "string") return v.trim() || null;
  if (typeof v === "number") return String(v);
  return null;
}

function num(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = parsePrice(v);
    return n;
  }
  if (v && typeof v === "object") {
    const o = v as AnyRec;
    return num(pick(o, ["amount", "value", "price", "min", "priceValue", "price_str", "priceStr", "display", "text"]));
  }
  return null;
}

function priceOf(obj: AnyRec, platform: string | null | undefined): { price: number | null; currency: string | null; priceText: string | null } {
  const rawVal = pick(obj, PRICE_KEYS);
  let price = num(rawVal);
  let priceText: string | null = typeof rawVal === "string" ? rawVal : null;
  let currency: string | null = str(pick(obj, ["currency", "currency_code", "currencyCode", "priceCurrency"]));
  if (rawVal && typeof rawVal === "object") {
    const o = rawVal as AnyRec;
    currency = currency ?? str(pick(o, ["currency", "currency_code", "currencyCode"]));
    priceText = priceText ?? str(pick(o, ["price_str", "priceStr", "display", "text", "formatted"]));
  }
  if (priceText && !currency) currency = guessCurrencyFromText(priceText);
  // Shopee and some marketplaces encode prices as integers x 100000
  if (price != null && (platform === "shopee" || platform === "shopee_seo") && price >= 100000 && Number.isInteger(price)) price = price / 100000;
  if (price != null && price > 100_000_000) price = null;
  return { price, currency, priceText };
}

function imagesOf(v: unknown, depth = 0): string[] {
  if (depth > 3 || v == null) return [];
  if (typeof v === "string") return /^https?:\/\//.test(v) ? [v] : /^\/\//.test(v) ? ["https:" + v] : /^[a-f0-9]{32}/.test(v) && v.length < 80 ? [`https://down-my.img.susercontent.com/file/${v}`] : [];
  if (Array.isArray(v)) return v.flatMap((x) => imagesOf(x, depth + 1)).slice(0, 12);
  if (typeof v === "object") {
    const o = v as AnyRec;
    return imagesOf(pick(o, ["url", "src", "urlList", "url_list", "large", "original", "imageUrl", "image_url", "hd"]), depth + 1);
  }
  return [];
}

function looksLikeProduct(o: AnyRec): boolean {
  const name = str(pick(o, NAME_KEYS));
  if (!name || name.length < 3 || name.length > 220) return false;
  const priceRaw = pick(o, PRICE_KEYS);
  if (priceRaw === undefined) return false;
  const price = num(priceRaw);
  if (price == null && typeof priceRaw !== "string") return false;
  // Skip shipping options, coupons, categories masquerading as products
  if (/^(free shipping|shipping|voucher|coupon|discount|delivery)\b/i.test(name)) return false;
  return true;
}

function toProduct(o: AnyRec, opts: HuntOptions): RawProduct | null {
  const title = str(pick(o, NAME_KEYS));
  if (!title) return null;
  const { price, currency, priceText } = priceOf(o, opts.platform);
  const compare = num(pick(o, COMPARE_KEYS));
  const idRaw = pick(o, ID_KEYS);
  const url = str(pick(o, URL_KEYS));
  const variantsRaw = pick(o, VARIANT_KEYS);
  const variants = Array.isArray(variantsRaw)
    ? (variantsRaw as unknown[])
        .filter((v): v is AnyRec => !!v && typeof v === "object")
        .map((v) => ({ title: str(pick(v, ["name", "title", "sku_name", "option", "value"])) ?? "Variant", price: priceOf(v, opts.platform).price, sku: str(pick(v, ["sku", "sku_id", "skuId", "code"])), image: imagesOf(pick(v, IMAGE_KEYS))[0] ?? null, stock: num(pick(v, STOCK_KEYS)) }))
        .filter((v) => v.title !== "Variant" || v.price != null)
        .slice(0, 40)
    : undefined;
  const desc = str(pick(o, DESC_KEYS));
  const soldRaw = pick(o, SOLD_KEYS);
  const sold = typeof soldRaw === "string" ? parseSold(soldRaw) : num(soldRaw);
  const ratingRaw = pick(o, RATING_KEYS);
  const rating = ratingRaw && typeof ratingRaw === "object" ? num(pick(ratingRaw as AnyRec, ["rating_star", "average", "avg", "score", "value"])) : num(ratingRaw);
  const base = opts.baseUrl;
  let absUrl = url;
  if (url && base && !/^https?:/.test(url)) {
    try {
      absUrl = new URL(url, base).toString();
    } catch {
      absUrl = null;
    }
  }
  return {
    title: title.replace(/\s+/g, " ").trim(),
    description: desc ? desc.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 2000) : null,
    price,
    currency,
    priceText,
    compareAtPrice: compare != null && (price == null || compare > price) ? (opts.platform === "shopee" && compare >= 100000 ? compare / 100000 : compare) : null,
    url: absUrl,
    images: imagesOf(pick(o, IMAGE_KEYS)),
    externalId: idRaw != null && (typeof idRaw === "string" || typeof idRaw === "number") ? String(idRaw) : null,
    soldCount: sold != null && sold >= 0 ? Math.round(sold) : null,
    rating: rating != null && rating > 0 && rating <= 5 ? rating : null,
    stock: num(pick(o, STOCK_KEYS)),
    variants: variants && variants.length ? variants : undefined,
    category: str(pick(o, ["category", "category_name", "categoryName", "product_type", "type"])),
    via: opts.via ?? "embedded-json",
  };
}

function parseSold(s: string): number | null {
  const m = s.replace(/,/g, "").match(/([\d.]+)\s*(k|rb|ribu|juta|m)?/i);
  if (!m) return null;
  let n = Number(m[1]);
  const unit = (m[2] ?? "").toLowerCase();
  if (unit === "k" || unit === "rb" || unit === "ribu") n *= 1000;
  if (unit === "juta" || unit === "m") n *= 1_000_000;
  return Number.isFinite(n) ? n : null;
}

/** Walk parsed JSON and collect product-like objects. */
export function huntProducts(blobs: unknown[], opts: HuntOptions = {}): RawProduct[] {
  const out: RawProduct[] = [];
  const seen = new Set<string>();
  let nodes = 0;
  const max = opts.maxProducts ?? 200;
  const visit = (node: unknown, depth: number) => {
    if (node == null || depth > 14 || nodes++ > MAX_NODES || out.length >= max) return;
    if (Array.isArray(node)) {
      for (const child of node) visit(child, depth + 1);
      return;
    }
    if (typeof node !== "object") return;
    const o = node as AnyRec;
    if (looksLikeProduct(o)) {
      const p = toProduct(o, opts);
      if (p) {
        const key = (p.externalId ?? p.url ?? p.title).toLowerCase();
        if (!seen.has(key)) {
          seen.add(key);
          out.push(p);
        }
      }
      // Products rarely nest other products except variants; still descend for lists inside.
    }
    for (const value of Object.values(o)) if (value && typeof value === "object") visit(value, depth + 1);
  };
  blobs.forEach((b) => visit(b, 0));
  return out;
}

export function huntProductsInHtml(html: string, opts: HuntOptions = {}): RawProduct[] {
  return huntProducts(extractJsonBlobs(html), opts);
}
