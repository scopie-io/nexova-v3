import { describe, expect, it } from "vitest";
import { extractJsonBlobs, huntProducts, huntProductsInHtml } from "./parsers/hunter.js";
import { mergeProducts, sanityCheck, titleSimilarity } from "./merge.js";
import { candidatesFromLinks, handleMatches, isBioLinkHost, isPlatformOperatorHandle, knownIdentities } from "./discover.js";
import { parseCsv, productsFromJsonFile, productsFromTable } from "./attachments.js";
import { buildCoverage } from "./coverage.js";
import { productsFromMarkdown } from "./providers/reader.js";
import { isThinHtml } from "./http.js";
import { emptySignals, type RawProduct } from "../schema/signals.js";

describe("embedded JSON hunter", () => {
  it("finds products in __NEXT_DATA__ and window state blobs", () => {
    const html = `<html><body>
<script id="__NEXT_DATA__" type="application/json">${JSON.stringify({ props: { pageProps: { shop: { name: "Kopi Aman" }, products: [{ id: 11, title: "Matcha Kit", price: "45.00", currency: "MYR", images: [{ src: "https://cdn.x/m.jpg" }], sold: "1.2k", rating: { average: 4.7 } }, { id: 12, title: "Free shipping voucher", price: 0 }] } } })}</script>
<script>window.__INITIAL_STATE__ = {"catalog":{"items":[{"product_name":"Kopi Tarik Box","sale_price":{"price_str":"RM 25.90"},"image_url":"//cdn.x/k.jpg","product_id":"99","skus":[{"name":"6 pcs","price":25.9},{"name":"12 pcs","price":48}]}]}};</script>
</body></html>`;
    const blobs = extractJsonBlobs(html);
    expect(blobs.length).toBeGreaterThanOrEqual(2);
    const products = huntProductsInHtml(html, { platform: "website", baseUrl: "https://kopiaman.com", via: "embedded-json" });
    const titles = products.map((p) => p.title);
    expect(titles).toContain("Matcha Kit");
    expect(titles).toContain("Kopi Tarik Box");
    expect(titles).not.toContain("Free shipping voucher");
    const matcha = products.find((p) => p.title === "Matcha Kit")!;
    expect(matcha).toMatchObject({ price: 45, currency: "MYR", externalId: "11", soldCount: 1200, rating: 4.7 });
    expect(matcha.images).toEqual(["https://cdn.x/m.jpg"]);
    const kopi = products.find((p) => p.title === "Kopi Tarik Box")!;
    expect(kopi).toMatchObject({ price: 25.9, currency: "MYR", externalId: "99" });
    expect(kopi.images).toEqual(["https://cdn.x/k.jpg"]);
    expect(kopi.variants?.map((v) => v.title)).toEqual(["6 pcs", "12 pcs"]);
  });

  it("scales Shopee integer prices", () => {
    const products = huntProducts([{ items: [{ name: "Tote Bag", price: 2590000, shopid: 1, itemid: 2, image: "abcdef0123456789abcdef0123456789" }] }], { platform: "shopee" });
    expect(products[0].price).toBe(25.9);
    expect(products[0].images[0]).toContain("susercontent.com/file/abcdef");
  });
});

describe("thin page detection", () => {
  it("flags SPA shells and accepts pages with metadata", () => {
    expect(isThinHtml('<html><body><div id="app"></div><script src="x.js"></script></body></html>')).toBe(true);
    expect(isThinHtml('<html><head><meta property="og:title" content="Shop"></head><body></body></html>')).toBe(false);
  });
});

describe("cross-source merge", () => {
  const p = (over: Partial<RawProduct>): RawProduct => ({ title: "Matcha Latte Kit", via: "reader-jina", images: [], ...over });

  it("merges the same product across sources with precedence and keeps notes on disagreement", () => {
    const merged = mergeProducts([
      p({ title: "Matcha Latte Kit 100g", price: 42, via: "reader-jina", images: ["https://a/1.jpg"] }),
      p({ title: "MATCHA LATTE KIT (100g) 🔥", price: 45, via: "shopify-products-json", images: ["https://a/2.jpg"], externalId: "s1", soldCount: 120 }),
      p({ title: "Matcha Latte Kit", price: 45, via: "csv", images: [] }),
      p({ title: "Ceramic Mug", price: 58, via: "reader-jina" }),
    ]);
    expect(merged).toHaveLength(2);
    const m = merged.find((x) => x.title.startsWith("Matcha"))!;
    expect(m.via).toBe("csv");
    expect(m.price).toBe(45);
    expect(m.images).toEqual(["https://a/2.jpg", "https://a/1.jpg"]);
    expect(m.externalId).toBe("s1");
    expect(m.soldCount).toBe(120);
    expect(m.notes?.some((n) => n.includes("confirmed by 3 sources"))).toBe(true);
  });

  it("prefers the fuller reading when two tiles of one screenshot disagree on price", () => {
    // Overlapping tiles: one caught only the struck-through original, one caught sale + original.
    const merged = mergeProducts([p({ title: "Men Cargo Shorts", price: 79, via: "vision" }), p({ title: "Men Cargo Shorts", price: 49, compareAtPrice: 79, via: "vision" })]);
    expect(merged).toHaveLength(1);
    expect(merged[0].price).toBe(49);
    expect(merged[0].compareAtPrice).toBe(79);
    expect(merged[0].notes?.some((n) => n.includes("price differs"))).toBe(false);
  });

  it("still flags a genuine price disagreement", () => {
    const merged = mergeProducts([p({ title: "Mystery Box", price: 30, via: "vision" }), p({ title: "Mystery Box", price: 90, via: "reader-jina" })]);
    expect(merged[0].notes?.some((n) => n.includes("price differs"))).toBe(true);
  });

  it("never merges two distinct listings from the same structured source", () => {
    const merged = mergeProducts([p({ title: "Men Basic Tee", price: 49, via: "shopify-products-json", externalId: "1" }), p({ title: "Men Basic Tee 3 Pack", price: 59, via: "shopify-products-json", externalId: "2" }), p({ title: "Men Basic Tee", price: 49, via: "reader-jina" })]);
    expect(merged).toHaveLength(2);
    expect(merged.find((m) => m.externalId === "1")?.notes?.some((n) => n.includes("confirmed by 2 sources"))).toBe(true);
  });

  it("does not merge similar titles with wildly different prices", () => {
    const merged = mergeProducts([p({ title: "Sofa Set 3 Seater", price: 1200 }), p({ title: "Sofa Set Cover 3 Seater", price: 35 })]);
    expect(merged).toHaveLength(2);
  });

  it("title similarity ignores marketing noise", () => {
    expect(titleSimilarity("READY STOCK Tote Bag Canvas 🔥", "Canvas Tote Bag")).toBeGreaterThanOrEqual(0.75);
    expect(titleSimilarity("Tote Bag", "Ceramic Mug")).toBe(0);
  });

  it("sanity checks flag missing prices, outliers and currency mismatches", () => {
    const out = sanityCheck([p({ price: 10, currency: "MYR" }), p({ title: "Gold Bar", price: 100000, currency: "MYR" }), p({ title: "Mystery", price: null }), p({ title: "USD item", price: 12, currency: "USD" })], "MYR");
    expect(out[1].notes?.some((n) => n.includes("outlier"))).toBe(true);
    expect(out[2].notes).toContain("no price found");
    expect(out[3].notes?.some((n) => n.includes("differs from store currency"))).toBe(true);
  });
});

describe("discovery", () => {
  it("recognizes bio-link hosts", () => {
    expect(isBioLinkHost("https://linktr.ee/kopiaman")).toBe(true);
    expect(isBioLinkHost("https://lynk.id/kopiaman")).toBe(true);
    expect(isBioLinkHost("https://kopiaman.com")).toBe(false);
  });

  it("matches handles loosely but safely", () => {
    const known = new Set(["kopiaman", "kedaikopiaman"]);
    expect(handleMatches("kopi.aman", known)).toBe(true);
    expect(handleMatches("kopiaman_official", known)).toBe(true);
    expect(handleMatches("kopiamanmy", known)).toBe(true);
    expect(handleMatches("someoneelse", known)).toBe(false);
    expect(handleMatches("ko", known)).toBe(false);
  });

  it("keeps only channels that look like the merchant, from links and from search", () => {
    const known = new Set(["kopiaman"]);
    const existing = new Set(["https://www.instagram.com/kopiaman/"]);
    const links = ["https://shopee.com.my/kopiaman", "https://www.tiktok.com/@kopi.aman", "https://www.facebook.com/sharer/sharer.php?u=x", "https://www.instagram.com/kopiaman/", "https://www.tiktok.com/@randomshop", "https://wa.me/60123456789", "https://www.lazada.com.my/shop/kopi-aman/"];
    const merchant = candidatesFromLinks(links, "bio", "merchant", known, existing);
    expect(merchant.map((c) => `${c.platform}:${c.handle}`)).toEqual(["shopee:kopiaman", "tiktok:kopi.aman", "lazada:kopi-aman"]);
    const search = candidatesFromLinks(links, "search", "search", known, existing);
    expect(search.map((c) => c.handle)).toEqual(["kopiaman", "kopi.aman", "kopi-aman"]);
  });

  it("never adopts the marketplace's own corporate accounts", () => {
    // These come from "Follow us on Facebook" chrome on a Shopee shop page.
    const links = ["https://www.tiktok.com/@shopeemy", "https://www.facebook.com/ShopeeMY", "https://instagram.com/Shopee_MY", "https://www.tiktok.com/@oxwhitemyofficial"];
    const kept = candidatesFromLinks(links, "shopee-page", "merchant", new Set(["oxwhite"]), new Set());
    expect(kept.map((c) => c.handle)).toEqual(["oxwhitemyofficial"]);
    expect(isPlatformOperatorHandle("shopeemy")).toBe(true);
    expect(isPlatformOperatorHandle("Shopee_MY")).toBe(true);
    expect(isPlatformOperatorHandle("lazada")).toBe(true);
    expect(isPlatformOperatorHandle("oxwhite")).toBe(false);
  });

  it("still discovers channels when the merchant is not identified yet", () => {
    const kept = candidatesFromLinks(["https://shopee.com.my/somebrand"], "bio", "merchant", new Set(), new Set());
    expect(kept.map((c) => c.handle)).toEqual(["somebrand"]);
  });

  it("collects known identities from signals", () => {
    const s = emptySignals({ url: "https://kopiaman.com", platform: "website", kind: "website", handle: null, region: null, externalId: null }, "x", "src1");
    s.siteName = "Kedai Kopi Aman";
    const known = knownIdentities([s]);
    expect(known.has("kedaikopiaman")).toBe(true);
    expect(known.has("kopiaman")).toBe(true);
  });
});

describe("attachments: tabular", () => {
  it("parses CSV with quotes and Shopify-style variant rows", () => {
    const csv = 'Title,Variant,Price,Compare At Price,Image Src,SKU,Category\n"Matcha Kit, Ceremonial",100g,45,55,https://a/1.jpg,MK-100,Tea\n"Matcha Kit, Ceremonial",200g,80,,https://a/2.jpg,MK-200,Tea\nCeramic Mug,,58,,https://a/m.jpg,CM-1,Home\n';
    const rows = parseCsv(csv);
    expect(rows[1][0]).toBe("Matcha Kit, Ceremonial");
    const products = productsFromTable(rows, "attachment:1");
    expect(products).toHaveLength(2);
    expect(products[0]).toMatchObject({ title: "Matcha Kit, Ceremonial", price: 45, compareAtPrice: 55, category: "Tea", via: "csv" });
    expect(products[0].variants?.map((v) => v.title)).toEqual(["100g", "200g"]);
    expect(products[0].images).toEqual(["https://a/1.jpg", "https://a/2.jpg"]);
    expect(products[1].title).toBe("Ceramic Mug");
  });

  it("parses TSV and Malay headers", () => {
    const rows = parseCsv("nama produk\tharga\tstok\nKuih Bahulu\tRM 12.50\t20\n");
    const products = productsFromTable(rows, "a");
    expect(products[0]).toMatchObject({ title: "Kuih Bahulu", price: 12.5, currency: "MYR", stock: 20 });
  });

  it("parses JSON product arrays", () => {
    const products = productsFromJsonFile({ products: [{ name: "Tote", price: 39, images: [{ src: "https://a/t.jpg" }] }] }, "a");
    expect(products[0]).toMatchObject({ title: "Tote", price: 39 });
    expect(products[0].images).toEqual(["https://a/t.jpg"]);
  });
});

describe("reader markdown products", () => {
  it("pairs price lines with preceding titles", () => {
    const md = `# Kedai Kopi Aman\n![img](https://cdn/a.jpg)\n[Matcha Latte Kit 100g](https://shopee.com.my/x-i.1.2)\nRM45.00\n1.2k sold\n\n![img](https://cdn/b.jpg)\nKopi Tarik Sachet Box\nRM25.90 - RM48.00\n\nFree shipping RM0`;
    const products = productsFromMarkdown(md, "reader-jina", "https://shopee.com.my/kopiaman", "shopee");
    expect(products.map((p) => p.title)).toEqual(["Matcha Latte Kit 100g", "Kopi Tarik Sachet Box"]);
    expect(products[0]).toMatchObject({ price: 45, currency: "MYR", url: "https://shopee.com.my/x-i.1.2" });
    expect(products[0].images).toEqual(["https://cdn/a.jpg"]);
    expect(products[1].price).toBe(25.9);
  });
});

describe("coverage report", () => {
  it("recommends screenshots for blocked marketplaces and WhatsApp when no contact", () => {
    const shopee = emptySignals({ url: "https://shopee.com.my/kopiaman", platform: "shopee", kind: "shop", handle: "kopiaman", region: "my", externalId: null }, "x", "s1");
    shopee.status = "blocked";
    shopee.attempts.push({ provider: "direct-fetch", ok: false, ms: 10, note: "403" });
    const ig = emptySignals({ url: "https://www.instagram.com/kopiaman/", platform: "instagram", kind: "profile", handle: "kopiaman", region: null, externalId: null }, "x", "s2");
    ig.status = "ok";
    ig.profile = { name: "Kopi Aman", handle: "kopiaman", bio: "kopi", avatar: null, followers: 10, verified: null, website: null };
    const products: RawProduct[] = [{ title: "Matcha", price: 45, via: "pasted-text", images: [] }];
    const c = buildCoverage([shopee, ig], [], products, [], ["Matcha - RM45"]);
    expect(c.sources[0].status).toBe("blocked");
    expect(c.recommendations.some((r) => /Shopee/.test(r) && /screenshot/i.test(r))).toBe(true);
    expect(c.recommendations.some((r) => /WhatsApp/.test(r))).toBe(true);
    expect(c.totals.profiles).toBe(1);
    expect(c.score).toBeGreaterThan(0.3);
    expect(c.score).toBeLessThan(0.8);
  });
});
