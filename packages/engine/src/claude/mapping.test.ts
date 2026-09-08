import { describe, expect, it } from "vitest";
import { applyEnrichment, buildSpec, normalizeWhatsapp, rawProductsFromTexts, socialUrl } from "./mapping.js";
import type { EnrichmentDraft, ProductDraft, StoreDraft } from "../schema/drafts.js";

const storeDraft: StoreDraft = {
  brand: { name: "Kedai Kopi Aman", handle: "kopiaman", tagline: "Kopi from Ipoh", description: "Small batch coffee.", industry: "food", tone: "warm", logoUrl: "https://cdn.example.com/logo.png", avatarUrl: "", heroImageUrl: "", country: "MY", city: "Ipoh", email: "", phone: "", whatsapp: "+60 12-345 6789", address: "", followers: 1200 },
  social: { tiktok: "@kopiaman", tiktokShop: "", instagram: "kopiaman", facebook: "", shopee: "https://shopee.com.my/kopiaman", lazada: "", whatsapp: "", telegram: "", youtube: "", x: "", website: "kopiaman.com" },
  commerce: { currency: "MYR", locale: "en", checkoutMode: "external_link", externalCheckoutUrl: "https://shopee.com.my/kopiaman", shippingNote: "", shippingRegions: ["MY"], returnsPolicy: "" },
  categories: [{ slug: "Coffee", name: "Coffee", description: "" }, { slug: "matcha", name: "Matcha", description: "" }, { slug: "unused", name: "Unused", description: "" }],
  warnings: [],
  confidence: 0.8,
};

const product = (over: Partial<ProductDraft>): ProductDraft => ({
  title: "Matcha Latte Kit",
  description: "Ceremonial grade matcha.",
  shortDescription: "Ceremonial matcha kit.",
  price: { amount: 45, currency: "MYR" },
  compareAtPrice: 55,
  images: [{ url: "https://cdn.example.com/m.jpg", alt: "" }, { url: "not-a-url", alt: "" }],
  options: [{ name: "Size", values: ["100g", "200g"] }],
  variants: [{ title: "100g", options: [{ name: "Size", value: "100g" }], price: 45, sku: "", imageUrl: "" }, { title: "200g", options: [{ name: "Size", value: "200g" }], price: 80, sku: "MK-200", imageUrl: "" }],
  categorySlugs: ["matcha"],
  tags: ["bestseller"],
  attributes: [{ name: "Grade", value: "Ceremonial" }],
  inventoryStatus: "unknown",
  rating: 4.8,
  ratingCount: 32,
  soldCount: 120,
  sourceUrl: "https://shopee.com.my/x-i.1.2",
  sourcePlatform: "shopee",
  externalId: "1.2",
  featured: true,
  confidence: 0.9,
  ...over,
});

describe("buildSpec", () => {
  it("produces a valid StoreSpec with normalized ids, currency, socials and whatsapp checkout", () => {
    const spec = buildSpec(storeDraft, [product({}), product({ title: "Matcha Latte Kit" }), product({ title: "Kopi Tarik", categorySlugs: ["coffee"], confidence: 0.2 })], {
      id: "job1",
      slug: "kopi-aman",
      engineVersion: "0.1.0",
      currencyOverride: null,
      sources: [],
      maxProducts: 60,
    });
    expect(spec.slug).toBe("kopi-aman");
    expect(spec.brand.contact.whatsapp).toBe("60123456789");
    expect(spec.commerce.checkout.mode).toBe("whatsapp");
    expect(spec.social.tiktok).toBe("https://www.tiktok.com/@kopiaman");
    expect(spec.social.instagram).toBe("https://www.instagram.com/kopiaman/");
    expect(spec.social.website).toBe("https://kopiaman.com");
    // Theme comes from the industry palette, not from the model.
    expect(spec.theme.colors.accent).toBe("#e07a1f");
    expect(spec.theme.preset).toBe("organic");
    expect(spec.theme.fonts.heading).toBe("Fraunces");
    // Copy defaults make the store presentable before enrichment runs.
    expect(spec.pages.home.heroTitle).toBe("Kopi from Ipoh");
    expect(spec.pages.home.usps).toHaveLength(3);
    expect(spec.pages.faq.length).toBeGreaterThanOrEqual(4);
    expect(spec.pages.faq[0].answer).toMatch(/WhatsApp/);
    expect(spec.pages.about.body).toBe("Small batch coffee.");
    expect(spec.seo.title).toBe("Kedai Kopi Aman | Official Store");
    const slugs = spec.catalog.products.map((p) => p.slug);
    expect(slugs).toEqual(["matcha-latte-kit", "matcha-latte-kit-2", "kopi-tarik"]);
    expect(spec.catalog.products[0].images).toHaveLength(1);
    expect(spec.catalog.products[0].variants[1].sku).toBe("MK-200");
    expect(spec.catalog.products[0].variants[0].sku).toBeNull();
    expect(spec.brand.logo?.url).toBe("https://cdn.example.com/logo.png");
    expect(spec.brand.avatar).toBeNull();
    expect(spec.brand.contact.email).toBeNull();
    expect(spec.catalog.products[0].compareAtPrice?.amount).toBe(55);
    expect(spec.catalog.products[0].variants[0].options).toEqual({ Size: "100g" });
    expect(spec.catalog.products[0].inventory.status).toBe("in_stock");
    expect(spec.catalog.products[2].visible).toBe(false);
    expect(spec.catalog.categories.map((c) => c.slug).sort()).toEqual(["coffee", "matcha"]);
    expect(spec.pages.home.featuredProductIds).toEqual(["matcha-latte-kit", "matcha-latte-kit-2"]);
    expect(spec.pages.home.sections.map((s) => s.type)).toContain("featured");
  });

  it("falls back to an 'all' category when none are used", () => {
    const spec = buildSpec({ ...storeDraft, categories: [] }, [product({ categorySlugs: [] })], { id: "j", slug: "s", engineVersion: "0", currencyOverride: "SGD", sources: [], maxProducts: 10 });
    expect(spec.catalog.categories[0].slug).toBe("all");
    expect(spec.commerce.currency).toBe("SGD");
  });
});

describe("applyEnrichment", () => {
  it("merges non-null fields, featured ids and template choice", () => {
    const spec = buildSpec(storeDraft, [product({}), product({ title: "Kopi Tarik", categorySlugs: ["coffee"] })], { id: "j", slug: "s", engineVersion: "0", currencyOverride: null, sources: [], maxProducts: 10 });
    const e: EnrichmentDraft = {
      brand: { tagline: "New tagline", description: "", story: "We roast in Ipoh every week.", tone: "" },
      theme: { preset: "bold", mode: "keep", primary: "", secondary: "", accent: "#123456", background: "", surface: "", text: "", headingFont: "", bodyFont: "", radius: "keep", rationale: "" },
      home: { heroTitle: "", heroSubtitle: "", heroCta: "", announcement: "Free shipping", featuredProductIds: ["kopi-tarik", "missing"], sections: [{ type: "featured", title: "Best", subtitle: "" }], usps: [] },
      faq: [{ question: "Q", answer: "A" }],
      seo: { title: "SEO", description: "", keywords: ["kopi"] },
      templateChoice: { templateId: "nexova-starter", reason: "fits" },
      warnings: ["check prices"],
    };
    const out = applyEnrichment(spec, e, ["nexova-starter"]);
    expect(out.brand.tagline).toBe("New tagline");
    expect(out.brand.description).toBe(spec.brand.description);
    expect(out.theme.preset).toBe("bold");
    expect(out.theme.colors.accent).toBe("#123456");
    expect(out.pages.home.announcement).toBe("Free shipping");
    expect(out.pages.home.featuredProductIds).toEqual(["kopi-tarik"]);
    // Enrichment owns the story; facts (catalog, categories, prices) are untouched.
    expect(out.pages.about.body).toBe("We roast in Ipoh every week.");
    expect(out.pages.faq).toEqual([{ question: "Q", answer: "A" }]);
    expect(out.catalog.products.map((p) => p.title)).toEqual(spec.catalog.products.map((p) => p.title));
    expect(out.catalog.categories).toEqual(spec.catalog.categories);
    expect(out.template.id).toBe("nexova-starter");
    expect(out.meta.warnings).toContain("check prices");
    expect(out.seo.title).toBe("SEO");
  });

  it("ignores unknown template ids", () => {
    const spec = buildSpec(storeDraft, [product({})], { id: "j", slug: "s", engineVersion: "0", currencyOverride: null, sources: [], maxProducts: 10 });
    const out = applyEnrichment(spec, { brand: { tagline: "", description: "", story: "", tone: "" }, theme: { preset: "keep", mode: "keep", primary: "", secondary: "", accent: "", background: "", surface: "", text: "", headingFont: "", bodyFont: "", radius: "keep", rationale: "" }, home: { heroTitle: "", heroSubtitle: "", heroCta: "", announcement: "", featuredProductIds: [], sections: [], usps: [] }, faq: [], seo: { title: "", description: "", keywords: [] }, templateChoice: { templateId: "nope", reason: "" }, warnings: [] }, ["nexova-starter"]);
    expect(out.template.id).toBeNull();
    // "keep" sentinels must not leak into the spec
    expect(out.theme.preset).toBe(spec.theme.preset);
    expect(out.theme.mode).toBe(spec.theme.mode);
    expect(out.theme.radius).toBe(spec.theme.radius);
  });
});

describe("helpers", () => {
  it("normalizes whatsapp numbers and social handles", () => {
    expect(normalizeWhatsapp("https://wa.me/60123456789?text=hi")).toBe("60123456789");
    expect(normalizeWhatsapp("+60 12-345 6789")).toBe("60123456789");
    expect(normalizeWhatsapp("123")).toBeNull();
    expect(socialUrl("tiktok", "@brand")).toBe("https://www.tiktok.com/@brand");
    expect(socialUrl("instagram", "https://instagram.com/brand")).toBe("https://instagram.com/brand");
  });

  it("parses pasted product lines", () => {
    const raw = rawProductsFromTexts(["Matcha Latte Kit - RM 45 (ceremonial grade)", "Kopi Tarik Sachet Box RM 25.90", "no price here", "1. Mug $12"], "my");
    expect(raw).toHaveLength(3);
    expect(raw[0]).toMatchObject({ title: "Matcha Latte Kit", price: 45, currency: "MYR", description: "ceremonial grade" });
    expect(raw[1]).toMatchObject({ title: "Kopi Tarik Sachet Box", price: 25.9 });
    expect(raw[2]).toMatchObject({ title: "Mug", price: 12, currency: "USD" });
  });
});
