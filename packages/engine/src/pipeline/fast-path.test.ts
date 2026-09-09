/**
 * The fast path trades Claude calls for the marketplace API's own catalog, so these tests pin
 * down exactly when it is allowed to fire and that mapping loses nothing on the way through.
 */
import { describe, expect, it } from "vitest";
import { fastPathReason } from "./stages.js";
import { productsFromSignals } from "../claude/mapping.js";
import { loadConfig } from "../config.js";
import type { EngineConfig } from "../config.js";
import type { JobRecord } from "../schema/job.js";
import type { IngestResult, RawProduct, SourceSignals } from "../schema/signals.js";
import type { StoreDraft } from "../schema/drafts.js";

const config: EngineConfig = loadConfig({ NEXOVA_OFFLINE: "1" } as NodeJS.ProcessEnv, process.cwd());

const rawProduct = (over: Partial<RawProduct> = {}): RawProduct => ({
  title: "Apple Cider Vinegar Gummies",
  description: "Vegan, non-GMO gummies with the mother.",
  price: 18.99,
  currency: "USD",
  compareAtPrice: 24.99,
  url: "https://www.tiktok.com/view/product/1729",
  images: ["https://cdn.example.com/acv.jpg"],
  externalId: "1729",
  soldCount: 4200,
  rating: 4.8,
  ratingCount: 310,
  stock: 42,
  variants: [{ title: "1 bottle", price: 18.99, sku: "ACV-1", image: null, stock: 42 }],
  options: [{ name: "Size", values: ["1 bottle", "3 bottles"] }],
  tags: ["gummies"],
  category: "Supplements",
  via: "tiktok-shop-api",
  sourcePlatform: "tiktok_shop",
  ...over,
});

const source = (over: Partial<SourceSignals> = {}): SourceSignals =>
  ({
    id: "s1",
    input: "https://www.tiktok.com/shop/store/goli/123",
    url: "https://www.tiktok.com/shop/store/goli/123",
    platform: "tiktok_shop",
    kind: "shop",
    status: "ok",
    providers: ["tiktok-shop-api"],
    products: [],
    discovered: false,
    errors: [],
    ...over,
  }) as unknown as SourceSignals;

const ingest = (over: Partial<IngestResult> = {}): IngestResult =>
  ({
    sources: [source()],
    texts: [],
    attachments: [],
    discovered: [],
    products: [rawProduct()],
    coverage: { gaps: [] },
    ...over,
  }) as unknown as IngestResult;

const job = (over: Partial<JobRecord["input"]> = {}): JobRecord =>
  ({
    id: "job_test",
    input: { raw: "https://www.tiktok.com/shop/store/goli/123", options: {}, attachments: [], ...over },
  }) as unknown as JobRecord;

const storeDraft: StoreDraft = {
  brand: { name: "Goli", handle: "goli", tagline: "", description: "", industry: "health", tone: "bold", logoUrl: "", avatarUrl: "", heroImageUrl: "", country: "US", city: "", email: "", phone: "", whatsapp: "", address: "", followers: 0 },
  social: { tiktok: "", tiktokShop: "", instagram: "", facebook: "", shopee: "", lazada: "", whatsapp: "", telegram: "", youtube: "", x: "", website: "" },
  commerce: { currency: "USD", locale: "en", checkoutMode: "external_link", externalCheckoutUrl: "", shippingNote: "", shippingRegions: [], returnsPolicy: "" },
  categories: [
    { slug: "supplements", name: "Supplements", description: "Daily vitamins" },
    { slug: "skincare", name: "Skincare", description: "Serums and creams" },
  ],
  warnings: [],
  confidence: 0.8,
};

describe("fastPathReason", () => {
  it("fires when a catalog API covered every readable source", () => {
    expect(fastPathReason(job(), ingest(), config)).toContain("tiktok-shop-api returned 1 products");
  });

  it("stands down when the merchant attached screenshots", () => {
    expect(fastPathReason(job({ attachments: [{ id: "a1" } as never] }), ingest(), config)).toBeNull();
  });

  it("stands down when a readable source the API did not cover is in play", () => {
    const extra = source({ id: "s2", platform: "instagram", providers: ["direct-fetch"], status: "ok" });
    expect(fastPathReason(job(), ingest({ sources: [source(), extra] }), config)).toBeNull();
  });

  it("stands down when some products came from elsewhere, e.g. pasted product lines", () => {
    const pasted = rawProduct({ via: "text", externalId: null });
    expect(fastPathReason(job(), ingest({ products: [rawProduct(), pasted] }), config)).toBeNull();
  });

  it("stands down when the job asks for the full ladder", () => {
    expect(fastPathReason(job({ options: { fastPath: "off" } }), ingest(), config)).toBeNull();
  });

  it("stands down when the engine has it disabled", () => {
    expect(fastPathReason(job(), ingest(), { ...config, fastPath: false })).toBeNull();
  });

  it("stands down when nothing was found", () => {
    expect(fastPathReason(job(), ingest({ products: [] }), config)).toBeNull();
  });
});

describe("productsFromSignals", () => {
  const opts = { maxProducts: 60, currency: "USD" };

  it("carries price, images, variants, stock and ratings across without Claude", () => {
    const [p] = productsFromSignals([rawProduct()], storeDraft, opts);
    expect(p.title).toBe("Apple Cider Vinegar Gummies");
    expect(p.price).toEqual({ amount: 18.99, currency: "USD" });
    expect(p.compareAtPrice).toBe(24.99);
    expect(p.images).toEqual([{ url: "https://cdn.example.com/acv.jpg", alt: "Apple Cider Vinegar Gummies" }]);
    expect(p.variants[0]).toMatchObject({ title: "1 bottle", price: 18.99, sku: "ACV-1" });
    expect(p.options[0]).toEqual({ name: "Size", values: ["1 bottle", "3 bottles"] });
    expect(p.inventoryStatus).toBe("in_stock");
    expect(p.rating).toBe(4.8);
    expect(p.soldCount).toBe(4200);
    expect(p.externalId).toBe("1729");
  });

  it("assigns a category from the store draft by label overlap", () => {
    const [p] = productsFromSignals([rawProduct()], storeDraft, opts);
    expect(p.categorySlugs).toEqual(["supplements"]);
  });

  it("leaves the category empty rather than guessing when nothing matches", () => {
    const [p] = productsFromSignals([rawProduct({ title: "Mystery box", category: null, tags: [] })], storeDraft, opts);
    expect(p.categorySlugs).toEqual([]);
  });

  it("keeps a complete record visible and marks a title-only row as doubtful", () => {
    const [full, bare] = productsFromSignals([rawProduct(), rawProduct({ title: "Banner", price: null, priceText: null, images: [] })], storeDraft, opts);
    expect(full.confidence).toBeGreaterThanOrEqual(0.9);
    expect(bare.confidence).toBeLessThan(0.3); // buildSpec hides anything under 0.3
  });

  it("reads a price out of priceText when there is no numeric price", () => {
    const [p] = productsFromSignals([rawProduct({ price: null, priceText: "RM 45.90" })], storeDraft, opts);
    expect(p.price.amount).toBe(45.9);
  });

  it("falls back to the job currency when the row does not carry one", () => {
    const [p] = productsFromSignals([rawProduct({ currency: null })], storeDraft, { maxProducts: 60, currency: "MYR" });
    expect(p.price.currency).toBe("MYR");
  });

  it("drops junk urls, untitled rows, and respects maxProducts", () => {
    const rows = [rawProduct({ images: ["not-a-url", "https://cdn.example.com/ok.jpg"] }), rawProduct({ title: "  " }), rawProduct({ title: "Third" })];
    const out = productsFromSignals(rows, storeDraft, { maxProducts: 2, currency: "USD" });
    expect(out).toHaveLength(1); // 2 rows considered, one of them untitled
    expect(out[0].images).toEqual([{ url: "https://cdn.example.com/ok.jpg", alt: "Apple Cider Vinegar Gummies" }]);
  });

  it("maps stock to an inventory status", () => {
    const status = (stock: number | null) => productsFromSignals([rawProduct({ stock })], storeDraft, opts)[0].inventoryStatus;
    expect(status(0)).toBe("out_of_stock");
    expect(status(3)).toBe("low_stock");
    expect(status(99)).toBe("in_stock");
    expect(status(null)).toBe("unknown");
  });
});
