/**
 * Cross-source product merging with provenance-based precedence and sanity checks.
 * The same product seen on Shopify, Shopee, a screenshot and a pasted line becomes one candidate
 * whose fields come from the most reliable source, with disagreements recorded as notes.
 */
import type { RawProduct } from "../schema/signals.js";

/** Higher wins. User-provided data (CSV, pasted text) is authoritative; archived data is weakest. */
export function precedence(via: string): number {
  if (via === "csv" || via === "json") return 100;
  if (via.startsWith("shopify-products-json")) return 96;
  if (via.startsWith("shopee-api") || via.startsWith("lazada-ajax")) return 94;
  if (via === "jsonld" || via.endsWith("-jsonld")) return 90;
  if (via.startsWith("embedded")) return 86;
  if (via.startsWith("playwright")) return 84;
  if (via === "pasted-text") return 80;
  if (via.startsWith("reader-firecrawl") || via.startsWith("reader-proxy")) return 70;
  if (via.startsWith("reader-jina")) return 62;
  if (via.startsWith("vision")) return 58;
  if (via.startsWith("wayback")) return 40;
  return 50;
}

const STOP = new Set(["the", "and", "for", "with", "new", "hot", "sale", "promo", "ready", "stock", "readystock", "free", "shipping", "original", "ori", "murah", "borong", "cod", "pcs", "pc", "set", "size", "colour", "color", "warna", "saiz", "x", "-", "&"]);

export function titleKey(title: string): string {
  return title
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, " ")
    .replace(/\[[^\]]*\]|\([^)]*\)/g, " ")
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 1 && !STOP.has(t))
    .sort()
    .join(" ");
}

export function titleSimilarity(a: string, b: string): number {
  const ta = new Set(titleKey(a).split(" ").filter(Boolean));
  const tb = new Set(titleKey(b).split(" ").filter(Boolean));
  if (!ta.size || !tb.size) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  const union = ta.size + tb.size - inter;
  const jaccard = inter / union;
  const containment = inter / Math.min(ta.size, tb.size);
  return Math.max(jaccard, containment >= 0.85 && Math.min(ta.size, tb.size) >= 2 ? 0.8 : 0);
}

interface Group {
  members: RawProduct[];
  ids: Set<string>;
  urls: Set<string>;
  key: string;
}

function sameProduct(p: RawProduct, g: Group): boolean {
  if (p.externalId && g.ids.has(p.externalId)) return true;
  if (p.url && g.urls.has(p.url)) return true;
  // Two listings from the same structured source with different ids are different products
  // (e.g. "Basic Tee" and "Basic Tee 3-Pack" in one Shopify catalog), however similar the titles.
  if (p.externalId && g.members.some((m) => m.via === p.via && m.externalId && m.externalId !== p.externalId)) return false;
  if (p.url && g.members.some((m) => m.via === p.via && m.url && m.url !== p.url)) return false;
  const sim = Math.max(...g.members.map((m) => titleSimilarity(p.title, m.title)));
  if (sim >= 0.75) {
    // Guard against merging size/colour variants sold as separate listings with very different prices.
    const price = p.price ?? null;
    const other = g.members.map((m) => m.price).find((x) => x != null) ?? null;
    if (price != null && other != null && other > 0 && Math.abs(price - other) / Math.max(price, other) > 0.6) return sim >= 0.95;
    return true;
  }
  return false;
}

function firstDefined<T>(members: RawProduct[], pick: (p: RawProduct) => T | null | undefined): T | null {
  for (const m of members) {
    const v = pick(m);
    if (v != null && v !== "" && !(Array.isArray(v) && v.length === 0)) return v;
  }
  return null;
}

/**
 * How complete one reading of a product is. Used to break ties between records of equal
 * provenance - notably two overlapping tiles of the same screenshot, where the fuller reading
 * (it captured both the sale price and the struck-through original) is the trustworthy one.
 */
export function completeness(p: RawProduct): number {
  let score = 0;
  if (p.price != null && p.price > 0) score += 3;
  if (p.compareAtPrice != null && p.compareAtPrice > (p.price ?? 0)) score += 3;
  if (p.images?.length) score += 2;
  if (p.description) score += 1;
  if (p.variants?.length) score += 1;
  if (p.externalId) score += 1;
  if (p.url) score += 1;
  if (p.soldCount != null) score += 1;
  return score;
}

export function mergeProducts(all: RawProduct[]): RawProduct[] {
  const groups: Group[] = [];
  const sorted = [...all]
    .filter((p) => p.title && p.title.trim().length >= 2)
    .sort((a, b) => precedence(b.via) - precedence(a.via) || completeness(b) - completeness(a));
  for (const p of sorted) {
    const g = groups.find((grp) => sameProduct(p, grp));
    if (g) {
      g.members.push(p);
      if (p.externalId) g.ids.add(p.externalId);
      if (p.url) g.urls.add(p.url);
    } else {
      groups.push({ members: [p], ids: new Set(p.externalId ? [p.externalId] : []), urls: new Set(p.url ? [p.url] : []), key: titleKey(p.title) });
    }
  }
  return groups.map((g) => {
    const m = g.members; // already precedence-ordered (highest first)
    const best = m[0];
    const notes = new Set<string>(m.flatMap((x) => x.notes ?? []));
    const price = firstDefined(m, (x) => (x.price != null && x.price > 0 ? x.price : null));
    const prices = m.map((x) => x.price).filter((x): x is number => x != null && x > 0);
    if (prices.length > 1) {
      const min = Math.min(...prices);
      const max = Math.max(...prices);
      // A higher reading that another record calls the struck-through original is not a real
      // disagreement: it is one reader catching the sale price and another catching the old one.
      const explainedBySale = m.some((x) => x.compareAtPrice != null && Math.abs(x.compareAtPrice - max) < 0.01);
      if (max > 0 && (max - min) / max > 0.3 && !explainedBySale) notes.add(`price differs across sources (${min}–${max}); using ${price}`);
    }
    const images = [...new Set(m.flatMap((x) => x.images ?? []))].slice(0, 12);
    const variants = firstDefined(m, (x) => (x.variants && x.variants.length ? x.variants : null)) ?? undefined;
    const options = firstDefined(m, (x) => (x.options && x.options.length ? x.options : null)) ?? undefined;
    const sources = [...new Set(m.map((x) => x.via))];
    return {
      title: best.title,
      description: firstDefined(m, (x) => x.description) ?? null,
      priceText: firstDefined(m, (x) => x.priceText) ?? null,
      price,
      currency: firstDefined(m, (x) => x.currency) ?? null,
      compareAtPrice: firstDefined(m, (x) => (x.compareAtPrice != null && x.compareAtPrice > (price ?? 0) ? x.compareAtPrice : null)),
      url: firstDefined(m, (x) => x.url) ?? null,
      images,
      externalId: firstDefined(m, (x) => x.externalId) ?? null,
      soldCount: m.reduce<number | null>((acc, x) => (x.soldCount != null ? Math.max(acc ?? 0, x.soldCount) : acc), null),
      rating: firstDefined(m, (x) => x.rating) ?? null,
      ratingCount: firstDefined(m, (x) => x.ratingCount) ?? null,
      stock: firstDefined(m, (x) => x.stock) ?? null,
      variants,
      options,
      tags: [...new Set(m.flatMap((x) => x.tags ?? []))].slice(0, 12),
      category: firstDefined(m, (x) => x.category) ?? null,
      via: best.via,
      evidence: firstDefined(m, (x) => x.evidence) ?? null,
      sourcePlatform: firstDefined(m, (x) => x.sourcePlatform) ?? null,
      notes: [...notes, ...(sources.length > 1 ? [`confirmed by ${sources.length} sources: ${sources.join(", ")}`] : [])],
    } satisfies RawProduct;
  });
}

/** Flag suspicious candidates so normalization (and the merchant) can double-check them. */
export function sanityCheck(products: RawProduct[], currencyHint: string | null): RawProduct[] {
  const prices = products.map((p) => p.price).filter((p): p is number => p != null && p > 0).sort((a, b) => a - b);
  const median = prices.length ? prices[Math.floor(prices.length / 2)] : null;
  return products.map((p) => {
    const notes = [...(p.notes ?? [])];
    if (p.price == null || p.price <= 0) notes.push("no price found");
    else if (median && (p.price > median * 50 || p.price < median / 200)) notes.push(`price ${p.price} is an outlier vs median ${median}; verify`);
    if (currencyHint && p.currency && p.currency !== currencyHint) notes.push(`currency ${p.currency} differs from store currency ${currencyHint}`);
    if (!p.images?.length) notes.push("no image");
    return { ...p, notes };
  });
}
