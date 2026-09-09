import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../../config.js";
import { emptySignals } from "../../schema/signals.js";
import { classifyUrl } from "../detect.js";
import { flattenRichDescription, interpretEnvelope, makeTikTokShopApiProvider, mapListProduct, mapProductDetail, matchShopByHandle, regionCandidates, searchQueriesForHandle } from "./tiktok-shop-api.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name: string) => JSON.parse(readFileSync(path.join(here, "__fixtures__", name), "utf8")) as Record<string, unknown>;
const listFixture = fixture("tiktok-shop-products.json");
const detailFixture = fixture("tiktok-shop-product.json");

const { fetchJsonMock } = vi.hoisted(() => ({ fetchJsonMock: vi.fn() }));
vi.mock("../http.js", () => ({ fetchJson: fetchJsonMock }));

describe("TikTok Shop API mappers", () => {
  it("maps a catalog row", () => {
    const row = (listFixture.data as Record<string, unknown>[])[0];
    const p = mapListProduct(row, { region: "US", evidence: "https://www.tiktok.com/shop/store/goli-nutrition/7495794203056835079" });
    expect(p).toMatchObject({ externalId: "1729527313880355335", price: 14.98, currency: "USD", rating: 4.5, ratingCount: 94627, via: "tiktok-shop-api", sourcePlatform: "tiktok_shop" });
    expect(p!.title).toMatch(/^Goli Ashwagandha/);
    expect(p!.images).toHaveLength(1);
    expect(p!.url).toBe("https://www.tiktok.com/view/product/1729527313880355335?region=US");
  });

  it("maps a product detail with seller profile, variants, stock and reviews", () => {
    const d = mapProductDetail(detailFixture.data as Record<string, unknown>, { region: null, evidence: "x" })!;
    expect(d.product).toMatchObject({ externalId: "1729527313880355335", price: 14.98, compareAtPrice: 19, currency: "USD", soldCount: 1301529, category: "Health", stock: 348339 });
    expect(d.product.images).toHaveLength(3);
    expect(d.product.description).toContain("90 Million");
    expect(d.product.description).toContain("Brand: Goli");
    expect(d.product.tags).toEqual(["Goli"]);
    expect(d.product.options).toEqual([{ name: "Size", values: ["1 Bottle"] }]);
    expect(d.product.variants).toBeUndefined(); // single SKU: no variant list
    expect(d.profile).toMatchObject({ name: "Goli Nutrition", followers: 598131, verified: true, location: "United States of America" });
    expect(d.profile.avatar).toMatch(/^https:\/\//);
    expect(d.shopId).toBe("7495794203056835079");
    expect(d.region).toBe("US");
    expect(d.reviews).toHaveLength(2);
    expect(d.reviews[0].rating).toBe(5);
    expect(d.stats).toMatchObject({ productCount: 52, soldCount: 5728730, followers: 598131 });
  });

  it("flattens rich-text description templates", () => {
    const out = flattenRichDescription({ ec_rich_blocks: [{ xl_ec_rich_text: { ec_rich_texts: [{ template: "{{a}}{{b}}", arguments: { "{{a}}": { text_attribute: { text: "Hello " } }, "{{b}}": { text_attribute: { text: "world" } } } }] } }, { image: { url_list: ["https://cdn/x.webp"] } }] });
    expect(out.text).toBe("Hello world");
    expect(out.images).toEqual(["https://cdn/x.webp"]);
  });

  it("interprets API envelopes", () => {
    expect(interpretEnvelope(200, { success: true, data: null, message: "Resource not found or unavailable." }, null).reason).toBe("not_found");
    expect(interpretEnvelope(200, { success: true, data: [], pagination: { has_more: false, cursor: null } }, null)).toMatchObject({ ok: true, reason: "ok", hasMore: false });
    expect(interpretEnvelope(429, { message: "You have exceeded the MONTHLY quota" }, null).reason).toBe("quota");
    expect(interpretEnvelope(403, null, "HTTP 403").reason).toBe("error");
    const page = interpretEnvelope(200, listFixture, null);
    expect(page).toMatchObject({ ok: true, hasMore: true, cursor: "WzM2OTM5LCIxNzMxMTczNzAzNDc1OTU4Mjc5Il0=" });
  });

  it("finds the merchant's shop in search results by handle", () => {
    const rows = [
      { shop_id: "1", shop_name: "PlayPlanet", product_id: "a", title: "Kalimba" },
      { shop_id: "2", shop_name: "Kalima.my", product_id: "b", title: "Top" },
      { shop_id: "2", shop_name: "Kalima.my", product_id: "c", title: "Abaya" },
    ];
    expect(matchShopByHandle(rows, "kalima.my")).toEqual({ shopId: "2", shopName: "Kalima.my" });
    expect(matchShopByHandle(rows, "@kalima_official")).toEqual({ shopId: "2", shopName: "Kalima.my" });
    expect(matchShopByHandle(rows, "playplanet")).toEqual({ shopId: "1", shopName: "PlayPlanet" });
    expect(matchShopByHandle(rows, "someoneelse")).toBeNull();
    expect(searchQueriesForHandle("kalima.my")).toEqual(["kalima.my", "kalima"]);
    expect(searchQueriesForHandle("goli")).toEqual(["goli"]);
  });

  it("orders region candidates and drops unknown ones", () => {
    expect(regionCandidates("us", ["MY", "SG", "US"])).toEqual(["US", "MY", "SG"]);
    expect(regionCandidates(null, ["my", "xx"])).toEqual(["MY"]);
    expect(regionCandidates(null, [])).toEqual(["US"]);
  });
});

describe("TikTok Shop URL detection", () => {
  it("reads store ids, product ids and regions", () => {
    expect(classifyUrl("https://www.tiktok.com/shop/store/goli-nutrition/7495794203056835079")).toMatchObject({ platform: "tiktok_shop", kind: "shop", handle: "goli-nutrition", externalId: "7495794203056835079" });
    expect(classifyUrl("https://shop.tiktok.com/us/pdp/1729527313880355335")).toMatchObject({ platform: "tiktok_shop", kind: "product", externalId: "1729527313880355335", region: "us" });
    expect(classifyUrl("https://www.tiktok.com/view/product/1729876543210?region=MY")).toMatchObject({ platform: "tiktok_shop", kind: "product", externalId: "1729876543210", region: "my", url: "https://www.tiktok.com/view/product/1729876543210?region=MY" });
  });
});

describe("TikTok Shop API provider", () => {
  const config = { ...loadConfig({ NEXOVA_OFFLINE: "1", RAPIDAPI_KEY: "test-key-1234567890abcdef", NEXOVA_TIKTOK_SHOP_REGIONS: "MY,US", NEXOVA_TIKTOK_SHOP_MAX_PAGES: "2", NEXOVA_TIKTOK_SHOP_DETAILS: "1" }), fetchTimeoutMs: 1000 };
  const log = { debug() {}, info() {}, warn() {}, error() {}, child: () => log } as unknown as Parameters<ReturnType<typeof makeTikTokShopApiProvider>["run"]>[2]["log"];
  const ctx = { config, log };
  const provider = makeTikTokShopApiProvider();

  beforeEach(() => {
    fetchJsonMock.mockReset();
    fetchJsonMock.mockImplementation(async (url: string, opts: { headers?: Record<string, string> }) => {
      const u = new URL(url);
      expect(opts.headers?.["x-rapidapi-key"]).toBe("test-key-1234567890abcdef");
      const region = u.searchParams.get("region");
      const notFound = { ok: true, status: 200, data: { success: true, data: null, message: "Resource not found or unavailable." }, error: null, blocked: false };
      if (region !== "US") return notFound;
      if (u.pathname === "/shop/products") {
        if (u.searchParams.get("cursor")) return { ok: true, status: 200, data: { success: true, data: [{ product_id: "999", title: "Page two item", price: 5, currency: "USD", image_url: "https://cdn/p2.webp", shop_id: "7495794203056835079" }], pagination: { has_more: false, cursor: null } }, error: null, blocked: false };
        return { ok: true, status: 200, data: listFixture, error: null, blocked: false };
      }
      if (u.pathname === "/shop/product") return { ok: true, status: 200, data: detailFixture, error: null, blocked: false };
      if (u.pathname === "/shop/showcase") return { ok: true, status: 200, data: { success: true, data: [{ product_id: "555", title: "Creator pick", price: 9.5, currency: "USD", image_url: "https://cdn/c.webp" }], pagination: { has_more: false, cursor: null } }, error: null, blocked: false };
      if (u.pathname === "/shop/search") {
        const q = u.searchParams.get("query") ?? "";
        const rows = /goli/i.test(q) ? [{ product_id: "s1", title: "Search hit", price: 1, currency: "USD", shop_id: "7495794203056835079", shop_name: "Goli Nutrition" }] : [];
        return { ok: true, status: 200, data: { success: true, data: rows, pagination: { has_more: false, cursor: null } }, error: null, blocked: false };
      }
      return { ok: false, status: 404, data: null, error: "Endpoint does not exist", blocked: false };
    });
  });

  it("only runs with a key, for TikTok Shop links and TikTok profiles", () => {
    const shop = classifyUrl("https://www.tiktok.com/shop/store/goli-nutrition/7495794203056835079")!;
    expect(provider.supports(shop, ctx)).toBe(true);
    expect(provider.supports(classifyUrl("https://www.tiktok.com/@goli")!, ctx)).toBe(true);
    expect(provider.supports(classifyUrl("https://www.instagram.com/goli/")!, ctx)).toBe(false);
    expect(provider.supports(shop, { ...ctx, config: { ...config, rapidApiKey: null } })).toBe(false);
  });

  it("reads a store: probes regions once, paginates, enriches the top product, fills the profile", async () => {
    const det = classifyUrl("https://www.tiktok.com/shop/store/goli-nutrition/7495794203056835079")!;
    const signals = emptySignals(det, det.url, "src_test");
    await provider.run(det, signals, ctx);
    expect(signals.status).toBe("ok");
    expect(signals.products).toHaveLength(6); // 5 on page one + 1 on page two
    expect(signals.products.filter((p) => p.via === "tiktok-shop-api")).toHaveLength(6);
    const first = signals.products[0];
    expect(first.description).toContain("90 Million"); // enriched by /shop/product
    expect(first.images!.length).toBeGreaterThanOrEqual(3);
    expect(first.stock).toBe(348339);
    expect(signals.profile).toMatchObject({ name: "Goli Nutrition", followers: 598131 });
    expect(signals.embedded.tiktokShop).toMatchObject({ shopId: "7495794203056835079", region: "US", productCount: 52 });
    expect(signals.embedded.tiktokShopReviews).toHaveLength(2);
    // MY (miss) + US page 1 + US page 2 + 1 detail = 4 requests, no re-probing of regions after the lock
    expect(fetchJsonMock).toHaveBeenCalledTimes(4);
    expect(signals.embedded.tiktokShopApiCalls).toBe(4);
    const regionsTried = fetchJsonMock.mock.calls.map((c) => new URL(c[0] as string).searchParams.get("region"));
    expect(regionsTried).toEqual(["MY", "US", "US", "US"]);
    expect(new URL(fetchJsonMock.mock.calls[1][0] as string).searchParams.get("shop_id")).toBe("7495794203056835079");
  });

  it("reads a product link, then the seller's whole catalog", async () => {
    const det = classifyUrl("https://shop.tiktok.com/us/pdp/1729527313880355335")!;
    const signals = emptySignals(det, det.url, "src_test");
    await provider.run(det, signals, ctx);
    expect(signals.status).toBe("ok");
    expect(signals.products.map((p) => p.externalId)).toContain("1729527313880355335");
    expect(signals.products.length).toBeGreaterThan(1);
    const regionsTried = fetchJsonMock.mock.calls.map((c) => new URL(c[0] as string).searchParams.get("region"));
    expect(regionsTried.every((r) => r === "US")).toBe(true); // URL region tried first, no wasted credits
  });

  it("reads a creator showcase, then finds the shop by handle when the showcase is thin", async () => {
    const det = classifyUrl("https://www.tiktok.com/@goli.nutrition")!;
    const signals = emptySignals(det, det.url, "src_test");
    await provider.run(det, signals, ctx);
    const showcase = signals.products.filter((p) => p.via === "tiktok-shop-api-showcase");
    expect(showcase).toHaveLength(1);
    expect(showcase[0].notes?.[0]).toMatch(/showcase/);
    // search "goli.nutrition" matched shop "Goli Nutrition" -> catalog pulled by shop id
    expect(signals.products.filter((p) => p.via === "tiktok-shop-api").length).toBeGreaterThanOrEqual(5);
    expect(signals.profile?.name).toBe("Goli Nutrition");
    const paths = fetchJsonMock.mock.calls.map((c) => new URL(c[0] as string).pathname);
    expect(paths).toContain("/shop/search");
    expect(paths).toContain("/shop/products");
  });

  it("stops on a quota error without throwing", async () => {
    fetchJsonMock.mockImplementation(async () => ({ ok: false, status: 429, data: { message: "You have exceeded the MONTHLY quota for Requests on your current plan, BASIC." }, error: "HTTP 429", blocked: false }));
    const det = classifyUrl("https://www.tiktok.com/shop/store/goli-nutrition/7495794203056835079")!;
    const signals = emptySignals(det, det.url, "src_test");
    await provider.run(det, signals, ctx);
    expect(signals.products).toHaveLength(0);
    expect(signals.errors[0]).toMatch(/quota/i);
    expect(fetchJsonMock).toHaveBeenCalledTimes(1);
  });
});
