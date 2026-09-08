/**
 * Drafts (what Claude returns) -> StoreSpec (what templates render). Also holds the
 * deterministic heuristics shared by the offline gateway.
 */
import type { EnrichmentDraft, ProductDraft, StoreDraft } from "../schema/drafts.js";
import type { RawProduct } from "../schema/signals.js";
import { parseStoreSpec, type Category, type Product, type StoreSpec } from "../schema/store-spec.js";
import { slugify, uniqueSlug } from "../util/ids.js";
import { guessCurrencyFromText, parsePrice } from "../util/text.js";
import { CURRENCY_BY_REGION } from "../ingest/detect.js";
import { defaultAbout, defaultFaq, defaultHomeCopy, defaultTheme, defaultUsps, type DefaultCopyInput } from "./defaults.js";

export interface BuildSpecOptions {
  id: string;
  slug: string;
  engineVersion: string;
  currencyOverride: string | null;
  sources: StoreSpec["sources"];
  maxProducts: number;
}

export function normalizeWhatsapp(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const m = raw.match(/wa\.me\/(\d+)/) ?? raw.match(/phone=(\d+)/);
  const digits = (m ? m[1] : raw).replace(/[^\d]/g, "");
  if (digits.length < 7 || digits.length > 16) return null;
  return digits;
}

export function socialUrl(kind: string, value: string | null): string | null {
  if (!value) return null;
  const v = value.trim();
  if (/^https?:\/\//i.test(v)) return v;
  const handle = v.replace(/^@/, "");
  switch (kind) {
    case "tiktok":
      return `https://www.tiktok.com/@${handle}`;
    case "instagram":
      return `https://www.instagram.com/${handle}/`;
    case "facebook":
      return `https://www.facebook.com/${handle}`;
    case "youtube":
      return handle.startsWith("@") ? `https://www.youtube.com/${handle}` : `https://www.youtube.com/@${handle}`;
    case "x":
      return `https://x.com/${handle}`;
    case "telegram":
      return `https://t.me/${handle}`;
    case "whatsapp": {
      const n = normalizeWhatsapp(v);
      return n ? `https://wa.me/${n}` : null;
    }
    default:
      return /^[\w.-]+\.[a-z]{2,}/i.test(v) ? `https://${v}` : v;
  }
}

/** Draft sentinels -> real absence. "" means unknown/none, 0 means unknown count. */
export function text(v: string | null | undefined): string | null {
  const s = (v ?? "").trim();
  return s ? s : null;
}
export function count(v: number | null | undefined): number | null {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null;
}

export function buildSpec(store: StoreDraft, products: ProductDraft[], opts: BuildSpecOptions): StoreSpec {
  const currency = (opts.currencyOverride || store.commerce.currency || "USD").toUpperCase();
  const categorySlugs = new Set<string>();
  const categories: Category[] = [];
  for (const c of store.categories) {
    const slug = slugify(c.slug || c.name, "category");
    if (categorySlugs.has(slug)) continue;
    categorySlugs.add(slug);
    categories.push({ slug, name: c.name || slug, description: c.description ?? "", image: null });
  }

  const takenSlugs = new Set<string>();
  const mapped: Product[] = [];
  const sorted = [...products].sort((a, b) => b.confidence - a.confidence);
  for (const p of sorted.slice(0, opts.maxProducts)) {
    const slug = uniqueSlug(slugify(p.title, "product"), takenSlugs);
    const priceCurrency = (p.price.currency || currency).toUpperCase();
    const prodCats = p.categorySlugs.map((s) => slugify(s)).filter((s) => categorySlugs.has(s));
    const optionNames = p.options.map((o) => o.name);
    mapped.push({
      id: slug,
      slug,
      title: p.title.trim(),
      description: p.description?.trim() ?? "",
      shortDescription: p.shortDescription?.trim() ?? "",
      price: { amount: round2(p.price.amount), currency: priceCurrency },
      compareAtPrice: p.compareAtPrice > p.price.amount ? { amount: round2(p.compareAtPrice), currency: priceCurrency } : null,
      images: dedupeImages(p.images.filter((i) => /^https?:\/\//.test(i.url)).map((i) => ({ url: i.url, alt: i.alt || p.title, width: null, height: null, sourceUrl: i.url }))),
      options: p.options.filter((o) => o.values.length > 0),
      variants: p.variants.map((v, i) => ({
        id: `${slug}-v${i + 1}`,
        title: v.title || v.options.map((o) => o.value).join(" / ") || `Variant ${i + 1}`,
        options: Object.fromEntries(v.options.filter((o) => optionNames.length === 0 || optionNames.includes(o.name)).map((o) => [o.name, o.value])),
        price: v.price > 0 ? { amount: round2(v.price), currency: priceCurrency } : null,
        compareAtPrice: null,
        sku: text(v.sku),
        image: v.imageUrl && /^https?:\/\//.test(v.imageUrl) ? { url: v.imageUrl, alt: v.title, width: null, height: null, sourceUrl: v.imageUrl } : null,
        inventory: { track: false, quantity: null, status: "in_stock" as const },
      })),
      inventory: { track: false, quantity: null, status: p.inventoryStatus === "unknown" ? "in_stock" : p.inventoryStatus },
      categories: prodCats,
      tags: [...new Set(p.tags.map((t) => t.trim()).filter(Boolean))].slice(0, 12),
      attributes: Object.fromEntries(p.attributes.filter((a) => a.name && a.value).map((a) => [a.name, a.value])),
      featured: p.featured,
      rating: count(p.rating) ? { average: p.rating, count: Math.round(count(p.ratingCount) ?? 0) } : null,
      soldCount: count(p.soldCount) ? Math.round(p.soldCount) : null,
      source: { platform: p.sourcePlatform, url: text(p.sourceUrl), externalId: text(p.externalId) },
      confidence: clamp01(p.confidence),
      visible: p.confidence >= 0.3,
    });
  }

  // Ensure every category has at least one product; drop empty ones unless the catalog is tiny.
  const used = new Set(mapped.flatMap((p) => p.categories));
  const finalCategories = categories.filter((c) => used.has(c.slug));
  if (finalCategories.length === 0 && mapped.length) {
    finalCategories.push({ slug: "all", name: "All products", description: "", image: null });
    for (const p of mapped) p.categories = ["all"];
  }

  const whatsapp = normalizeWhatsapp(store.brand.whatsapp) ?? normalizeWhatsapp(store.social.whatsapp);
  const externalUrl = text(store.commerce.externalCheckoutUrl);
  const checkoutMode = whatsapp ? "whatsapp" : externalUrl ? "external_link" : store.commerce.checkoutMode === "whatsapp" ? "none" : store.commerce.checkoutMode;

  // Normalization returns facts only; design and copy start from deterministic defaults and are
  // refined by the enrich step, so the store is already coherent even if enrichment fails.
  const brandName = store.brand.name.trim() || "My Store";
  const copy: DefaultCopyInput = {
    brandName,
    tagline: store.brand.tagline,
    description: store.brand.description,
    industry: store.brand.industry,
    hasWhatsapp: !!whatsapp,
    shippingNote: store.commerce.shippingNote,
    returnsPolicy: store.commerce.returnsPolicy,
  };
  const hero = defaultHomeCopy(copy);

  const spec = parseStoreSpec({
    id: opts.id,
    slug: opts.slug,
    brand: {
      name: brandName,
      handle: text(store.brand.handle)?.replace(/^@/, "") ?? null,
      tagline: store.brand.tagline,
      description: store.brand.description,
      story: "",
      logo: imageRef(store.brand.logoUrl, `${brandName} logo`),
      avatar: imageRef(store.brand.avatarUrl, brandName),
      heroImage: imageRef(store.brand.heroImageUrl, brandName),
      industry: store.brand.industry,
      audience: "",
      tone: store.brand.tone,
      values: [],
      location: { country: text(store.brand.country), city: text(store.brand.city) },
      contact: { email: text(store.brand.email), phone: text(store.brand.phone), whatsapp, address: text(store.brand.address) },
      followers: count(store.brand.followers) ? Math.round(store.brand.followers) : null,
    },
    theme: defaultTheme(store.brand.industry),
    social: {
      tiktok: socialUrl("tiktok", store.social.tiktok),
      tiktokShop: text(store.social.tiktokShop),
      instagram: socialUrl("instagram", store.social.instagram),
      facebook: socialUrl("facebook", store.social.facebook),
      shopee: text(store.social.shopee),
      lazada: text(store.social.lazada),
      whatsapp: whatsapp ? `https://wa.me/${whatsapp}` : null,
      telegram: socialUrl("telegram", store.social.telegram),
      youtube: socialUrl("youtube", store.social.youtube),
      x: socialUrl("x", store.social.x),
      website: socialUrl("website", store.social.website),
      email: text(store.brand.email),
    },
    catalog: { products: mapped, categories: finalCategories, collections: [] },
    pages: {
      home: {
        heroTitle: hero.heroTitle,
        heroSubtitle: hero.heroSubtitle,
        heroCta: hero.heroCta,
        announcement: "",
        featuredProductIds: mapped.filter((p) => p.featured && p.visible).slice(0, 8).map((p) => p.id),
        sections: defaultSections(mapped.length, finalCategories.length, 0, 4),
        usps: defaultUsps(copy),
      },
      about: defaultAbout(copy),
      faq: defaultFaq(copy),
      testimonials: [],
      contact: { title: "Contact", body: "" },
    },
    commerce: {
      currency,
      locale: store.commerce.locale || "en",
      checkout: { mode: checkoutMode, whatsappNumber: whatsapp, externalUrl },
      shipping: { note: store.commerce.shippingNote, regions: store.commerce.shippingRegions, freeShippingThreshold: null },
      policies: { returns: store.commerce.returnsPolicy, privacy: "", terms: "" },
    },
    seo: { title: `${brandName} | Official Store`, description: store.brand.description || hero.heroSubtitle, keywords: [brandName, store.brand.industry, ...finalCategories.map((c) => c.name)].filter(Boolean), ogImage: null },
    sources: opts.sources,
    meta: { engineVersion: opts.engineVersion, confidence: clamp01(store.confidence), warnings: store.warnings },
  });
  return spec;
}

export function applyEnrichment(spec: StoreSpec, e: EnrichmentDraft, availableTemplateIds: string[]): StoreSpec {
  const next: StoreSpec = structuredClone(spec);
  const b = e.brand;
  if (b.tagline) next.brand.tagline = b.tagline;
  if (b.description) next.brand.description = b.description;
  if (b.story) next.brand.story = b.story;
  if (b.tone) next.brand.tone = b.tone;

  const t = e.theme;
  if (t.preset && t.preset !== "keep") next.theme.preset = t.preset;
  if (t.mode && t.mode !== "keep") next.theme.mode = t.mode;
  if (t.primary) next.theme.colors.primary = hex(t.primary, next.theme.colors.primary);
  if (t.secondary) next.theme.colors.secondary = hex(t.secondary, next.theme.colors.secondary);
  if (t.accent) next.theme.colors.accent = hex(t.accent, next.theme.colors.accent);
  if (t.background) next.theme.colors.background = hex(t.background, next.theme.colors.background);
  if (t.surface) next.theme.colors.surface = hex(t.surface, next.theme.colors.surface);
  if (t.text) next.theme.colors.text = hex(t.text, next.theme.colors.text);
  if (t.headingFont) next.theme.fonts.heading = t.headingFont;
  if (t.bodyFont) next.theme.fonts.body = t.bodyFont;
  if (t.radius && t.radius !== "keep") next.theme.radius = t.radius;

  const h = e.home;
  if (h.heroTitle) next.pages.home.heroTitle = h.heroTitle;
  if (h.heroSubtitle) next.pages.home.heroSubtitle = h.heroSubtitle;
  if (h.heroCta) next.pages.home.heroCta = h.heroCta;
  if (h.announcement) next.pages.home.announcement = h.announcement;
  const ids = new Set(next.catalog.products.map((p) => p.id));
  const featured = h.featuredProductIds.filter((id) => ids.has(id));
  if (featured.length) {
    next.pages.home.featuredProductIds = featured.slice(0, 8);
    for (const p of next.catalog.products) p.featured = featured.includes(p.id);
  }
  if (h.sections.length) next.pages.home.sections = h.sections;
  if (h.usps.length) next.pages.home.usps = h.usps.slice(0, 4);

  if (b.story) next.pages.about.body = b.story;
  if (e.faq.length) next.pages.faq = e.faq;
  if (e.seo.title) next.seo.title = e.seo.title;
  if (e.seo.description) next.seo.description = e.seo.description;
  if (e.seo.keywords.length) next.seo.keywords = e.seo.keywords;
  if (e.templateChoice.templateId && availableTemplateIds.includes(e.templateChoice.templateId)) {
    next.template = { id: e.templateChoice.templateId, reason: e.templateChoice.reason };
  }
  next.meta.warnings = [...new Set([...next.meta.warnings, ...e.warnings])];
  next.meta.updatedAt = new Date().toISOString();
  return parseStoreSpec(next);
}

export function defaultSections(productCount: number, categoryCount: number, testimonialCount: number, faqCount: number): StoreSpec["pages"]["home"]["sections"] {
  const sections: StoreSpec["pages"]["home"]["sections"] = [];
  sections.push({ type: "usp", title: "", subtitle: "" });
  if (productCount > 0) sections.push({ type: "featured", title: "Featured", subtitle: "" });
  if (categoryCount > 1) sections.push({ type: "categories", title: "Shop by category", subtitle: "" });
  sections.push({ type: "story", title: "Our story", subtitle: "" });
  if (testimonialCount > 0) sections.push({ type: "testimonials", title: "What customers say", subtitle: "" });
  if (faqCount > 0) sections.push({ type: "faq", title: "FAQ", subtitle: "" });
  sections.push({ type: "socials", title: "Follow along", subtitle: "" });
  return sections;
}

/** Parse pasted product lines such as "Matcha Latte Kit - RM 45", "Tote bag RM25.90 (canvas, 2 colors)". */
export function rawProductsFromTexts(texts: string[], region: string | null): RawProduct[] {
  const out: RawProduct[] = [];
  const priceRe = /(RM|MYR|SGD|S\$|Rp|IDR|PHP|₱|THB|฿|VND|₫|NT\$|USD|US\$|\$|€|£|A\$|R\$)\s?([\d.,]+)|([\d.,]+)\s?(RM|MYR|SGD|IDR|PHP|THB|VND|USD|EUR|GBP|k)\b/i;
  for (const line of texts) {
    const m = line.match(priceRe);
    if (!m) continue;
    const priceText = m[0];
    const numRaw = m[2] ?? m[3] ?? "";
    let price = parsePrice(numRaw);
    if (price != null && /k$/i.test(m[4] ?? "")) price *= 1000;
    const title = line
      .replace(priceText, "")
      .replace(/\(([^)]*)\)/g, "")
      .replace(/^\s*[-*•\d.)]+\s*/, "")
      .replace(/\s*[-–:|,@]+\s*$/g, "")
      .replace(/\s{2,}/g, " ")
      .trim();
    if (!title || title.length < 2) continue;
    const descMatch = line.match(/\(([^)]+)\)/);
    out.push({
      title,
      description: descMatch ? descMatch[1] : null,
      priceText,
      price,
      currency: guessCurrencyFromText(priceText) ?? (region ? CURRENCY_BY_REGION[region] ?? null : null),
      images: [],
      via: "pasted-text",
    });
  }
  return out;
}

function imageRef(url: string | null | undefined, alt: string): StoreSpec["brand"]["logo"] {
  const u = (url ?? "").trim();
  if (!u || !/^https?:\/\//.test(u)) return null;
  return { url: u, alt, width: null, height: null, sourceUrl: u };
}

function dedupeImages<T extends { url: string }>(imgs: T[]): T[] {
  const seen = new Set<string>();
  return imgs.filter((i) => (seen.has(i.url) ? false : (seen.add(i.url), true))).slice(0, 10);
}

function hex(v: string | null | undefined, fallback: string): string {
  if (!v) return fallback;
  const s = v.trim();
  if (/^#[0-9a-f]{6}$/i.test(s)) return s.toLowerCase();
  if (/^#[0-9a-f]{3}$/i.test(s)) return ("#" + s.slice(1).split("").map((c) => c + c).join("")).toLowerCase();
  if (/^[0-9a-f]{6}$/i.test(s)) return "#" + s.toLowerCase();
  return fallback;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, Number.isFinite(n) ? n : 0.5));
}
