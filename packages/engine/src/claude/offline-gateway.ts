/**
 * Deterministic gateway used when no API key is configured (and in tests). It builds a
 * sensible store from raw signals with plain heuristics. Quality is lower than Claude's, but
 * the whole pipeline (ingest -> spec -> template -> build -> deploy) works offline.
 */
import type { EnrichmentDraft, ProductDraft, StoreDraft } from "../schema/drafts.js";
import type { AttachmentExtract, RawProduct, ResearchFindings, SourceSignals } from "../schema/signals.js";
import { CURRENCY_BY_REGION, LOCALE_BY_REGION } from "../ingest/detect.js";
import { slugify } from "../util/ids.js";
import { firstSentence, isBoilerplateDescription, leafCategory, titleCase } from "../util/text.js";
import type { AttachmentVisionInput, ClaudeGateway, EnrichInput, GatewayContext, GatewayPing, NormalizeProductsInput, NormalizeStoreInput, ResearchInput, SchemaCheck } from "./gateway.js";
import { NexovaError } from "./gateway.js";
import { paletteFor } from "./defaults.js";
import { normalizeWhatsapp } from "./mapping.js";

const INDUSTRY_HINTS: Array<[RegExp, string]> = [
  [/skincare|serum|beauty|cosmetic|makeup|lip|hijab|tudung|perfume|fragrance/i, "beauty"],
  [/dress|shirt|baju|kurung|tee|hoodie|fashion|apparel|wear|sneaker|shoe|bag|tote/i, "fashion"],
  [/coffee|matcha|cookie|cake|kuih|sambal|snack|food|drink|tea|honey|kitchen/i, "food"],
  [/phone|gadget|earbud|charger|cable|electronic|tech|laptop/i, "electronics"],
  [/candle|decor|home|furniture|ceramic|pottery|plant/i, "home"],
  [/handmade|craft|crochet|knit|resin|art|print/i, "handmade"],
  [/baby|kids|toy|children/i, "kids"],
  [/pet|cat|dog/i, "pets"],
  [/gym|yoga|sport|fitness|jersey/i, "sports"],
  [/supplement|vitamin|health|wellness/i, "health"],
];

export class OfflineGateway implements ClaudeGateway {
  readonly id = "offline";

  async ping(): Promise<GatewayPing> {
    throw new NexovaError("offline gateway: no Claude credentials configured", "offline", false);
  }

  async validateSchemas(): Promise<SchemaCheck[]> {
    return [];
  }

  async extractFromAttachments(input: AttachmentVisionInput, ctx: GatewayContext): Promise<AttachmentExtract[]> {
    ctx.onProgress?.(`Offline mode: ${input.images.length} image(s) skipped (screenshot reading needs Claude)`);
    return [];
  }

  async research(_input: ResearchInput, ctx: GatewayContext): Promise<ResearchFindings> {
    ctx.onProgress?.("Offline mode: skipping web research");
    return { markdown: "", citations: [], searches: 0, fetches: 0, skipped: true };
  }

  async normalizeStore(input: NormalizeStoreInput, ctx: GatewayContext): Promise<StoreDraft> {
    ctx.onProgress?.("Offline mode: deriving store from signals");
    const sources = input.ingest.sources;
    const primary = pickPrimary(sources);
    const attachmentShop = input.ingest.attachments.find((a) => a.shopName || a.handle) ?? null;
    const profile =
      sources.map((s) => s.profile).find(Boolean) ??
      (attachmentShop ? { name: attachmentShop.shopName, handle: attachmentShop.handle, bio: attachmentShop.bio, avatar: null, followers: attachmentShop.followers, verified: null, website: attachmentShop.contacts.website, phone: attachmentShop.contacts.whatsapp ?? attachmentShop.contacts.phone, email: attachmentShop.contacts.email, location: attachmentShop.location } : null);
    const org = sources.map((s) => s.embedded.organization as { name?: string; description?: string; logo?: string; email?: string; phone?: string; address?: string; sameAs?: string[] } | undefined).find(Boolean);
    const name = cleanName(profile?.name || org?.name || primary?.siteName || primary?.title || profile?.handle || primary?.handle || firstWords(input.ingest.texts[0] ?? "", 4) || "My Store");
    const handle = profile?.handle || sources.map((s) => s.handle).find(Boolean) || null;
    const allText = [profile?.bio, org?.description, primary?.description, ...sources.map((s) => s.text), ...input.ingest.texts, ...sources.flatMap((s) => s.products.map((p) => p.title))].filter(Boolean).join(" ");
    const industry = INDUSTRY_HINTS.find(([re]) => re.test(allText))?.[1] ?? "other";
    const region = sources.map((s) => s.region).find(Boolean) ?? null;
    const currency = input.currencyHint || (region ? CURRENCY_BY_REGION[region] : null) || sources.flatMap((s) => s.products.map((p) => p.currency)).find(Boolean) || "USD";
    const locale = input.localeHint || (region ? LOCALE_BY_REGION[region] : null) || "en";
    const bio = [profile?.bio, org?.description, ...sources.map((s) => s.description)].map((b) => (b ?? "").trim()).find((b) => b.length >= 12 && !isBoilerplateDescription(b)) ?? "";
    const whatsapp = normalizeWhatsapp(sources.map((s) => s.contacts.whatsapp).find(Boolean) ?? input.ingest.attachments.map((a) => a.contacts.whatsapp).find(Boolean) ?? profile?.phone ?? org?.phone ?? findWhatsapp(allText) ?? findWhatsapp(sources.flatMap((s) => s.links).join(" ")));
    const email = sources.map((s) => s.contacts.email).find(Boolean) || profile?.email || org?.email || allText.match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i)?.[0] || null;
    const pal = paletteFor(industry);
    const links = sources.flatMap((s) => s.links);
    const find = (re: RegExp) => sources.find((s) => re.test(s.url))?.url ?? links.find((l) => re.test(l)) ?? null;
    const categories = deriveCategories(sources.flatMap((s) => s.products), industry);
    const marketplace = find(/shopee\./) ?? find(/lazada\./) ?? find(/tiktok\.com\/(shop|view)|shop\.tiktok/);
    return {
      brand: {
        name,
        handle: handle ?? "",
        tagline: bio ? firstSentence(bio, 60) : `${titleCase(industry)} you will love`,
        description: bio ? firstSentence(bio, 220) : `${name} brings you carefully chosen ${industry === "other" ? "products" : industry + " products"}, sold directly through our social channels and now our own online store.`,
        industry,
        tone: pal.preset === "luxe" ? "premium" : pal.preset === "playful" ? "playful" : "warm",
        logoUrl: org?.logo ?? "",
        avatarUrl: profile?.avatar ?? "",
        heroImageUrl: pickHero(sources)?.url ?? "",
        country: region ? region.toUpperCase() : "",
        city: "",
        email: email ?? "",
        phone: profile?.phone ?? org?.phone ?? "",
        whatsapp: whatsapp ?? "",
        address: org?.address ?? profile?.location ?? "",
        followers: profile?.followers ?? 0,
      },
      social: {
        tiktok: find(/tiktok\.com\/@/) ?? "",
        tiktokShop: find(/tiktok\.com\/(shop|view)|shop\.tiktok/) ?? "",
        instagram: find(/instagram\.com\//) ?? "",
        facebook: find(/facebook\.com\//) ?? "",
        shopee: find(/shopee\./) ?? "",
        lazada: find(/lazada\./) ?? "",
        whatsapp: whatsapp ? `https://wa.me/${whatsapp}` : "",
        telegram: find(/t\.me\//) ?? "",
        youtube: find(/youtube\.com\//) ?? "",
        x: find(/(x|twitter)\.com\//) ?? "",
        website: profile?.website ?? "",
      },
      commerce: {
        currency,
        locale,
        checkoutMode: whatsapp ? "whatsapp" : marketplace ? "external_link" : "none",
        externalCheckoutUrl: marketplace ?? "",
        shippingNote: "",
        shippingRegions: region ? [region.toUpperCase()] : [],
        returnsPolicy: "",
      },
      categories,
      warnings: [...sources.filter((s) => s.status === "blocked" || s.status === "failed").map((s) => `${s.platform} link could not be read (${s.status}); results may be incomplete: ${s.url}`), ...input.ingest.coverage.recommendations.slice(0, 3)],
      confidence: profile || sources.some((s) => s.products.length) ? 0.6 : 0.35,
    };
  }

  async normalizeProducts(input: NormalizeProductsInput, ctx: GatewayContext): Promise<ProductDraft[]> {
    ctx.onProgress?.(`Offline mode: normalizing ${input.rawProducts.length} product candidates`);
    const currency = input.store.commerce.currency;
    const catSlugs = input.store.categories.map((c) => c.slug);
    const out: ProductDraft[] = [];
    const seen = new Set<string>();
    for (const raw of input.rawProducts) {
      const title = cleanTitle(raw.title);
      const key = title.toLowerCase();
      if (!title || seen.has(key)) continue;
      seen.add(key);
      const cat = pickCategory(title + " " + (raw.description ?? ""), catSlugs, raw.category);
      const price = raw.price ?? 0;
      out.push({
        title,
        description: raw.description?.trim() || `${title} from ${input.store.brand.name}.`,
        shortDescription: raw.description ? firstSentence(raw.description, 120) : `${title} by ${input.store.brand.name}.`,
        price: { amount: price, currency: raw.currency ?? currency },
        compareAtPrice: raw.compareAtPrice && raw.compareAtPrice > price ? raw.compareAtPrice : 0,
        images: (raw.images ?? []).slice(0, 8).map((u) => ({ url: u, alt: title })),
        options: (raw.options ?? []).map((o) => ({ name: o.name, values: o.values })),
        variants: (raw.variants ?? []).slice(0, 30).map((v) => ({ title: v.title, options: [], price: v.price ?? 0, sku: v.sku ?? "", imageUrl: v.image ?? "" })),
        categorySlugs: cat ? [cat] : [],
        tags: (raw.tags ?? []).slice(0, 8),
        attributes: [],
        inventoryStatus: raw.stock === 0 ? "out_of_stock" : "in_stock",
        rating: raw.rating ?? 0,
        ratingCount: raw.ratingCount ?? 0,
        soldCount: raw.soldCount ?? 0,
        sourceUrl: raw.url ?? "",
        sourcePlatform: raw.sourcePlatform ?? (raw.via.startsWith("shopee") ? "shopee" : raw.via.includes("shopify") ? "shopify" : raw.via.startsWith("lazada") ? "lazada" : raw.via === "pasted-text" || raw.via === "csv" || raw.via === "json" ? "text" : "website"),
        externalId: raw.externalId ?? "",
        featured: false,
        confidence: price > 0 && (raw.images?.length ?? 0) > 0 ? 0.85 : price > 0 ? 0.6 : 0.35,
      });
    }
    return out.slice(0, input.maxProducts);
  }

  async enrich(input: EnrichInput, ctx: GatewayContext): Promise<EnrichmentDraft> {
    ctx.onProgress?.("Offline mode: choosing template and layout by rules");
    const spec = input.spec;
    const withImages = spec.catalog.products.filter((p) => p.images.length && p.price.amount > 0);
    const featured = (withImages.length ? withImages : spec.catalog.products).slice(0, 8).map((p) => p.id);
    const choice = chooseTemplateByRules(input.templates, spec);
    return {
      brand: { tagline: "", description: "", story: "", tone: "" },
      theme: { preset: "keep", mode: "keep", primary: "", secondary: "", accent: "", background: "", surface: "", text: "", headingFont: "", bodyFont: "", radius: "keep", rationale: "kept" },
      home: { heroTitle: "", heroSubtitle: "", heroCta: "", announcement: "", featuredProductIds: featured, sections: [], usps: [] },
      faq: [],
      seo: { title: "", description: "", keywords: [] },
      templateChoice: { templateId: choice?.id ?? "", reason: choice ? `Rule-based match on ${spec.brand.industry || "general"} / ${spec.theme.preset}` : "no templates available" },
      warnings: [],
    };
  }
}

export function chooseTemplateByRules(templates: EnrichInput["templates"], spec: EnrichInput["spec"]): EnrichInput["templates"][number] | null {
  if (!templates.length) return null;
  const count = spec.catalog.products.length;
  let best: { t: EnrichInput["templates"][number]; score: number } | null = null;
  for (const t of templates) {
    let score = 0;
    if (t.industries.includes(spec.brand.industry)) score += 4;
    if (t.industries.length === 0 || t.industries.includes("any")) score += 1;
    if (t.style.preset && t.style.preset === spec.theme.preset) score += 3;
    if (t.style.tags.includes(spec.theme.preset)) score += 2;
    if (t.style.mode === spec.theme.mode || t.style.mode === "both") score += 1;
    if (count >= t.minProducts) score += 1;
    else score -= 3;
    if (t.maxProducts != null && count > t.maxProducts) score -= 2;
    if (t.id === "nexova-starter") score -= 0.5; // prefer designed templates when available
    if (!best || score > best.score) best = { t, score };
  }
  return best?.t ?? null;
}

// ---------- helpers ----------

function pickPrimary(sources: SourceSignals[]): SourceSignals | null {
  const order: Record<string, number> = { profile: 0, shop: 1, website: 2, product: 3, post: 4, text: 5 };
  return [...sources].filter((s) => s.status !== "failed").sort((a, b) => (order[a.kind] ?? 9) - (order[b.kind] ?? 9))[0] ?? sources[0] ?? null;
}

function cleanName(s: string): string {
  return s
    .replace(/\s*[|•·-]\s*(TikTok|Instagram|Facebook|Shopee|Lazada|Online Shop|Official Store).*$/i, "")
    .replace(/^\(@[^)]+\)\s*/, "")
    .replace(/\s*\(@[^)]+\)\s*$/, "")
    .replace(/\s+on (TikTok|Instagram)$/i, "")
    .replace(/\s{2,}/g, " ")
    .trim()
    .slice(0, 60);
}

function cleanTitle(s: string): string {
  return s
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, "")
    .replace(/\[(hot|new|sale|ready stock|promo)[^\]]*\]/gi, "")
    .replace(/\b(READY STOCK|FREE GIFT|HOT SALE)\b/gi, "")
    .replace(/\s{2,}/g, " ")
    .trim()
    .slice(0, 120);
}

function firstWords(s: string, n: number): string {
  return s.split(/\s+/).slice(0, n).join(" ");
}

function findWhatsapp(text: string): string | null {
  const m = text.match(/wa\.me\/(\d{7,16})/) ?? text.match(/whatsapp[^\d]{0,20}(\+?\d[\d\s-]{7,15}\d)/i);
  return m ? m[1] : null;
}

function pickHero(sources: SourceSignals[]): { url: string; alt: string } | null {
  for (const s of sources) {
    const og = s.openGraph["og:image"] ?? s.openGraph["og:image:secure_url"];
    if (og && /^https?:/.test(og)) return { url: og, alt: s.title ?? "" };
  }
  const first = sources.flatMap((s) => s.products.flatMap((p) => p.images ?? []))[0] ?? sources.flatMap((s) => s.images)[0];
  return first ? { url: first, alt: "" } : null;
}

function deriveCategories(products: RawProduct[], industry: string): StoreDraft["categories"] {
  const counts = new Map<string, number>();
  for (const p of products) {
    const c = p.category?.trim();
    if (c) {
      const leaf = leafCategory(c);
      if (leaf) counts.set(leaf, (counts.get(leaf) ?? 0) + 1);
    }
  }
  const cats = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([name]) => ({ slug: slugify(name, "category"), name, description: "" }));
  if (cats.length) return cats;
  const generic: Record<string, string[]> = {
    beauty: ["Skincare", "Makeup", "Body care"],
    fashion: ["New arrivals", "Tops", "Bottoms", "Accessories"],
    food: ["Best sellers", "Snacks", "Drinks"],
    electronics: ["Gadgets", "Accessories"],
    home: ["Decor", "Living", "Gifts"],
    handmade: ["Handmade", "Gifts"],
  };
  const names = generic[industry] ?? ["All products"];
  return names.map((n) => ({ slug: slugify(n), name: n, description: "" }));
}

function pickCategory(text: string, slugs: string[], rawCategory: string | null | undefined): string | null {
  if (rawCategory) {
    for (const candidate of [slugify(leafCategory(rawCategory)), slugify(rawCategory)]) if (slugs.includes(candidate)) return candidate;
  }
  const t = text.toLowerCase();
  for (const slug of slugs) {
    const words = slug.split("-").filter((w) => w.length > 3);
    if (words.some((w) => t.includes(w))) return slug;
  }
  return slugs[0] ?? null;
}
