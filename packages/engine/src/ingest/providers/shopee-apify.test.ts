import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../../config.js";
import { emptySignals } from "../../schema/signals.js";
import { classifyUrl } from "../detect.js";
import { countryFor, decodeEntities, makeShopeeApifyProvider, mapApifyRow, originalPriceFrom, shopSelectorFor } from "./shopee-apify.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const rows = JSON.parse(readFileSync(path.join(here, "__fixtures__", "shopee-apify-shop.json"), "utf8")) as Record<string, unknown>[];

const { fetchJsonMock } = vi.hoisted(() => ({ fetchJsonMock: vi.fn() }));
vi.mock("../http.js", () => ({ fetchJson: fetchJsonMock }));

describe("Shopee Apify mappers", () => {
  it("maps a real row and decodes the escaped text", () => {
    const p = mapApifyRow(rows[0], { evidence: "https://shopee.com.my/kiehls.os" })!;
    expect(p).toMatchObject({ externalId: "687386865.17809025121", price: 147, currency: "MYR", rating: 4.9, via: "shopee-apify", sourcePlatform: "shopee" });
    // the actor returns HTML-escaped text, in the URL as well as the title
    expect(p.title).toBe("Kiehl's Calendula Deep Cleansing Foaming Face Wash (230ml)");
    expect(p.title).not.toContain("&#");
    expect(p.url).not.toContain("&#");
    expect(p.url).toMatch(/-i\.687386865\.17809025121$/);
    expect(p.images).toHaveLength(1); // the SPA leaves one image per product, not a gallery
    // discount_pct 11 recovers a pre-discount price that original_price does not carry
    expect(p.compareAtPrice).toBeCloseTo(165.17, 1);
    expect(p.description).toBeNull();
    expect(p.stock).toBeNull();
  });

  it("decodes the entities the actor actually emits", () => {
    expect(decodeEntities("Kiehl&#x27;s &amp; Co &quot;x&quot;")).toBe(`Kiehl's & Co "x"`);
    expect(decodeEntities("plain")).toBe("plain");
    expect(decodeEntities("&#39;")).toBe("'");
  });

  it("recovers the pre-discount price, and refuses nonsense", () => {
    expect(originalPriceFrom(147, 11)).toBeCloseTo(165.17, 1);
    expect(originalPriceFrom(100, 0)).toBeNull();
    expect(originalPriceFrom(100, 100)).toBeNull();
    expect(originalPriceFrom(null, 20)).toBeNull();
  });

  it("takes a shop selector from a shop link or a product's id pair", () => {
    expect(shopSelectorFor({ kind: "shop", handle: "kiehls.os", externalId: null })).toBe("kiehls.os");
    expect(shopSelectorFor({ kind: "shop", handle: null, externalId: "687386865" })).toBe("687386865");
    // the actor takes a numeric shop id, so a product link does reach the catalogue
    expect(shopSelectorFor({ kind: "product", handle: null, externalId: "687386865.17809025121" })).toBe("687386865");
    expect(shopSelectorFor({ kind: "website", handle: null, externalId: null })).toBeNull();
  });

  it("maps the country enum, Taiwan included", () => {
    expect(countryFor("my")).toBe("my");
    expect(countryFor("TW")).toBe("tw");
    expect(countryFor("gb")).toBeNull();
    expect(countryFor(null)).toBeNull();
  });
});

describe("Shopee Apify provider", () => {
  const config = { ...loadConfig({ NEXOVA_OFFLINE: "1", APIFY_TOKEN: "apify_api_testtoken1234567890" }), fetchTimeoutMs: 1000 };
  const log = { debug() {}, info() {}, warn() {}, error() {}, child: () => log } as unknown as Parameters<ReturnType<typeof makeShopeeApifyProvider>["run"]>[2]["log"];
  const ctx = { config, log };
  const provider = makeShopeeApifyProvider();

  const thin = (url: string) => {
    const det = classifyUrl(url)!;
    return { det, signals: emptySignals(det, det.url, "src_test") };
  };

  beforeEach(() => {
    fetchJsonMock.mockReset();
    fetchJsonMock.mockImplementation(async () => ({ ok: true, status: 201, data: rows, error: null, blocked: false }));
  });

  it("runs only with a token, for Shopee links it can build a selector for", () => {
    expect(provider.supports(classifyUrl("https://shopee.com.my/kiehls.os")!, ctx)).toBe(true);
    expect(provider.supports(classifyUrl("https://shopee.com.my/Kiehls-i.687386865.17809025121")!, ctx)).toBe(true);
    expect(provider.supports(classifyUrl("https://www.lazada.com.my/shop/x")!, ctx)).toBe(false);
    expect(provider.supports(classifyUrl("https://shopee.com.my/kiehls.os")!, { ...ctx, config: { ...config, apifyToken: null } })).toBe(false);
  });

  it("scrapes a thin shop and records that the page was truncated", async () => {
    const { det, signals } = thin("https://shopee.com.my/kiehls.os");
    await provider.run(det, signals, ctx);
    expect(signals.status).toBe("ok");
    expect(signals.products).toHaveLength(4);
    expect(signals.products[0].title).toBe("Kiehl's Calendula Deep Cleansing Foaming Face Wash (230ml)");
    expect(signals.images.length).toBeGreaterThan(0);
    const body = JSON.parse(fetchJsonMock.mock.calls[0][1].body as string);
    expect(body).toMatchObject({ country: "my", mode: "shop", shop: "kiehls.os", fetchDetail: false });
    expect(body.maxProducts).toBeLessThanOrEqual(30); // shop mode never returns more than one page
  });

  it("reaches the seller's catalogue from one of their product links", async () => {
    const { det, signals } = thin("https://shopee.com.my/Kiehls-i.687386865.17809025121");
    await provider.run(det, signals, ctx);
    expect(JSON.parse(fetchJsonMock.mock.calls[0][1].body as string).shop).toBe("687386865");
    expect(signals.products).toHaveLength(4);
  });

  it("spends nothing when the free providers already read the shop", async () => {
    const { det, signals } = thin("https://shopee.com.my/kiehls.os");
    signals.status = "ok";
    signals.title = "Kiehl's";
    signals.products = [1, 2, 3].map((i) => ({ title: `Existing ${i}`, via: "shopee-api" }));
    await provider.run(det, signals, ctx);
    expect(fetchJsonMock).not.toHaveBeenCalled();
  });

  it("names a rejected token rather than reporting a generic failure", async () => {
    fetchJsonMock.mockImplementation(async () => ({ ok: false, status: 401, data: null, error: "HTTP 401", blocked: true }));
    const { det, signals } = thin("https://shopee.com.my/kiehls.os");
    await provider.run(det, signals, ctx);
    expect(signals.products).toHaveLength(0);
    expect(signals.errors[0]).toMatch(/APIFY_TOKEN rejected/);
  });
});
