import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../../config.js";
import { emptySignals } from "../../schema/signals.js";
import { classifyUrl, regionFromShortHost, SHOPEE_SHORT_HOST } from "../detect.js";
import { countryFor, interpretJob, makeShopeeScraperProvider, mapShopeeRow, parseSoldEstimate, shopFromRows, shopUrlFor } from "./shopee-scraper-api.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const jobFixture = JSON.parse(readFileSync(path.join(here, "__fixtures__", "shopee-scraper-job.json"), "utf8")) as Record<string, unknown>;
const rows = jobFixture.results as Record<string, unknown>[];

const { fetchJsonMock } = vi.hoisted(() => ({ fetchJsonMock: vi.fn() }));
vi.mock("../http.js", () => ({ fetchJson: fetchJsonMock }));

describe("Shopee scraper mappers", () => {
  const opts = { origin: "https://shopee.com.my", currency: null, evidence: "https://shopee.com.my/fkilla.my" };

  it("maps a real catalog row", () => {
    const p = mapShopeeRow(rows[0], opts)!;
    expect(p).toMatchObject({
      // ids arrive as JSON numbers; a string-only read would have lost the externalId entirely
      externalId: "460953684.22786742010",
      price: 6.38,
      compareAtPrice: 17.31,
      currency: "MYR",
      rating: 4.96,
      ratingCount: 167,
      soldCount: 500, // "500+"
      via: "shopee-scraper-api",
      sourcePlatform: "shopee",
    });
    expect(p.title).toMatch(/^FKILLA1 Faucet Spray Head/);
    expect(p.url).toMatch(/-i\.460953684\.22786742010$/);
    expect(p.images!.length).toBeGreaterThan(1);
    expect(p.options).toEqual([{ name: "Option", values: expect.arrayContaining(["Silver Short", "Black Long"]) }]);
    expect(p.priceText).toBe("6.38 - 12.3"); // variants span a range
    // the catalog carries none of these; enrichment's job, not a mapping bug
    expect(p.description).toBeNull();
    expect(p.stock).toBeNull();
    expect(p.category).toBeNull();
  });

  it("reads the seller's own name and location off the rows", () => {
    expect(shopFromRows(rows)).toEqual({ name: "fkilla.my", location: "China Continental" });
    expect(shopFromRows([])).toEqual({ name: null, location: null });
  });

  it("parses the sold-count display strings", () => {
    expect(parseSoldEstimate("500+")).toBe(500);
    expect(parseSoldEstimate("1k+")).toBe(1_000); // plain number parsing would have said 1
    expect(parseSoldEstimate("2.5k+")).toBe(2_500);
    expect(parseSoldEstimate("1m+")).toBe(1_000_000);
    // an upper bound only: inventing 100 would outrank a product with a real count of 90
    expect(parseSoldEstimate("<100")).toBeNull();
    expect(parseSoldEstimate(4321)).toBe(4321);
    expect(parseSoldEstimate(null)).toBeNull();
  });

  it("drops a row with no title", () => {
    expect(mapShopeeRow({ itemId: 1, shopId: 2, price: 9.9 }, opts)).toBeNull();
  });

  it("maps the country enum from the marketplace domain", () => {
    expect(countryFor("my")).toBe("MY");
    expect(countryFor("BR")).toBe("BR");
    expect(countryFor("tw")).toBeNull(); // Shopee runs there, the API does not
    expect(countryFor(null)).toBeNull();
  });

  // Measured against the live API: the username form returns the seller's products, /shop/<id>
  // finishes with count: 0. A product link only ever yields the numeric id, so it cannot be used.
  it("accepts only a username-form shop URL", () => {
    expect(shopUrlFor({ url: "https://shopee.com.my/fkilla.my", kind: "shop", handle: "fkilla.my" })).toBe("https://shopee.com.my/fkilla.my");
    expect(shopUrlFor({ url: "https://shopee.com.my/shop/460953684", kind: "shop", handle: null })).toBeNull();
    expect(shopUrlFor({ url: "https://shopee.com.my/product/191539183/22936183746", kind: "product", handle: null })).toBeNull();
    expect(shopUrlFor({ url: "https://shopee.com.my/x", kind: "website", handle: null })).toBeNull();
  });

  it("interprets real submit and poll responses", () => {
    const submitted = interpretJob(202, { success: true, status: "running", jobId: "abc", resultUrl: "/jobs/abc", pollAfterSeconds: 10 }, null);
    expect(submitted).toMatchObject({ state: "running", jobId: "abc", pollAfterMs: 10_000 });
    expect(interpretJob(200, jobFixture, null)).toMatchObject({ state: "done" });
    expect(interpretJob(200, jobFixture, null).rows).toHaveLength(4);
    // a finished job that simply matched nothing - what /shop/<id> actually returned
    const empty = interpretJob(200, { success: true, jobId: "x", status: "done", count: 0, notice: "No results matched.", results: [] }, null);
    expect(empty).toMatchObject({ state: "done" });
    expect(empty.rows).toEqual([]);
    expect(interpretJob(429, { message: "You have exceeded the MONTHLY quota for Searches on your current plan, BASIC." }, null).state).toBe("quota");
    expect(interpretJob(403, null, "HTTP 403").state).toBe("error");
    expect(interpretJob(202, { status: "running", jobId: "a", pollAfterSeconds: 900 }, null).pollAfterMs).toBe(15_000);
    expect(interpretJob(202, { status: "running", jobId: "a" }, null).pollAfterMs).toBe(5_000);
  });
});

describe("Shopee URL detection", () => {
  it("reads shop handles and product id pairs", () => {
    expect(classifyUrl("https://shopee.com.my/kopikampung")).toMatchObject({ platform: "shopee", kind: "shop", handle: "kopikampung", region: "my" });
    expect(classifyUrl("https://shopee.com.my/Kopi-Kampung-i.191539183.22936183746")).toMatchObject({ platform: "shopee", kind: "product", externalId: "191539183.22936183746", region: "my" });
    expect(classifyUrl("https://shopee.com.my/product/1189382932/51016100817")).toMatchObject({ platform: "shopee", kind: "product", externalId: "1189382932.51016100817", region: "my" });
  });

  // The app's share sheet hands out my.shp.ee links; before this they classified as a plain website
  // and never reached a Shopee provider at all.
  it("recognises the share-sheet short links and their market", () => {
    expect(classifyUrl("https://my.shp.ee/DMJnpYqg")).toMatchObject({ platform: "shopee", kind: "shop", region: "my" });
    expect(classifyUrl("https://sg.shope.ee/abc")).toMatchObject({ platform: "shopee", kind: "shop", region: "sg" });
    expect(classifyUrl("https://shp.ee/abc")).toMatchObject({ platform: "shopee", kind: "shop", region: null });
    expect(regionFromShortHost("my.shp.ee")).toBe("my");
    expect(regionFromShortHost("shp.ee")).toBeNull();
    expect(SHOPEE_SHORT_HOST.test("shopee.com.my")).toBe(false);
  });
});

describe("Shopee scraper provider", () => {
  const config = { ...loadConfig({ NEXOVA_OFFLINE: "1", RAPIDAPI_KEY: "test-key-1234567890abcdef", NEXOVA_MAX_PRODUCTS: "60" }), fetchTimeoutMs: 1000 };
  const log = { debug() {}, info() {}, warn() {}, error() {}, child: () => log } as unknown as Parameters<ReturnType<typeof makeShopeeScraperProvider>["run"]>[2]["log"];
  const ctx = { config, log };
  // Injecting a no-op sleep keeps the polling loop honest without the real 10s waits.
  const provider = makeShopeeScraperProvider({ sleep: async () => {} });

  const thin = (url: string) => {
    const det = classifyUrl(url)!;
    return { det, signals: emptySignals(det, det.url, "src_test") };
  };

  beforeEach(() => {
    fetchJsonMock.mockReset();
    let polls = 0;
    fetchJsonMock.mockImplementation(async (url: string, opts: { headers?: Record<string, string> }) => {
      const u = new URL(url);
      expect(opts.headers?.["x-rapidapi-key"]).toBe("test-key-1234567890abcdef");
      if (u.pathname === "/shopee") {
        return { ok: true, status: 202, data: { success: true, status: "running", jobId: "job1", resultUrl: "/jobs/job1", pollAfterSeconds: 10 }, error: null, blocked: false };
      }
      if (u.pathname === "/jobs/job1") {
        // still working on the first poll, finished on the second
        polls += 1;
        if (polls < 2) return { ok: true, status: 200, data: { success: true, status: "running", jobId: "job1", pollAfterSeconds: 5 }, error: null, blocked: false };
        return { ok: true, status: 200, data: jobFixture, error: null, blocked: false };
      }
      return { ok: false, status: 404, data: null, error: "Endpoint does not exist", blocked: false };
    });
  });

  it("only runs with a key, for Shopee shop and product links", () => {
    const shop = classifyUrl("https://shopee.com.my/kopikampung")!;
    expect(provider.supports(shop, ctx)).toBe(true);
    expect(provider.supports(classifyUrl("https://shopee.com.my/Kopi-i.191539183.22936183746")!, ctx)).toBe(true);
    expect(provider.supports(classifyUrl("https://shp.ee/abc123")!, ctx)).toBe(false);
    expect(provider.supports(classifyUrl("https://www.lazada.com.my/shop/kopi")!, ctx)).toBe(false);
    expect(provider.supports(shop, { ...ctx, config: { ...config, rapidApiKey: null } })).toBe(false);
  });

  it("submits the shop URL, polls to completion, and keeps the products", async () => {
    const { det, signals } = thin("https://shopee.com.my/kopikampung");
    await provider.run(det, signals, ctx);
    expect(signals.status).toBe("ok");
    expect(signals.products).toHaveLength(4);
    expect(signals.products[0]).toMatchObject({ externalId: "460953684.22786742010", price: 6.38, via: "shopee-scraper-api" });
    expect(signals.profile).toMatchObject({ name: "fkilla.my", location: "China Continental" });
    expect(signals.embedded.shopeeScraper).toMatchObject({ country: "MY", shopUrl: "https://shopee.com.my/kopikampung", requested: 60, shopName: "fkilla.my" });
    expect(signals.canonicalUrl).toBe("https://shopee.com.my/kopikampung");
    expect(signals.images.length).toBeGreaterThan(0);
    // 1 submit + 2 polls; polls are cheap requests, not billed results
    expect(fetchJsonMock).toHaveBeenCalledTimes(3);
    expect(signals.embedded.shopeeScraperCalls).toBe(3);
    const submit = new URL(fetchJsonMock.mock.calls[0][0] as string);
    expect(submit.searchParams.get("shopUrl")).toBe("https://shopee.com.my/kopikampung");
    expect(submit.searchParams.get("country")).toBe("MY");
    expect(submit.searchParams.get("maxItems")).toBe("60");
  });

  it("refuses to pay for a product link it cannot turn into a shop URL", async () => {
    const { det, signals } = thin("https://shopee.com.my/Kopi-Kampung-i.191539183.22936183746");
    await provider.run(det, signals, ctx);
    expect(fetchJsonMock).not.toHaveBeenCalled();
    expect(signals.errors[0]).toMatch(/paste the shop link instead/);
  });

  it("spends nothing when the free providers already filled the source", async () => {
    const { det, signals } = thin("https://shopee.com.my/kopikampung");
    signals.status = "ok";
    signals.title = "Kopi Kampung";
    signals.products = [1, 2, 3].map((i) => ({ title: `Existing ${i}`, via: "shopee-api" }));
    await provider.run(det, signals, ctx);
    expect(fetchJsonMock).not.toHaveBeenCalled();
    expect(signals.products).toHaveLength(3);
  });

  it("skips a marketplace the API does not cover, without paying to find out", async () => {
    const { det, signals } = thin("https://shopee.tw/kopikampung");
    await provider.run(det, signals, ctx);
    expect(fetchJsonMock).not.toHaveBeenCalled();
    expect(signals.errors[0]).toMatch(/outside the API's countries/);
  });

  it("stops on a quota error without throwing", async () => {
    fetchJsonMock.mockImplementation(async () => ({ ok: false, status: 429, data: { message: "You have exceeded the MONTHLY quota for Results on your current plan, BASIC." }, error: "HTTP 429", blocked: false }));
    const { det, signals } = thin("https://shopee.com.my/kopikampung");
    await provider.run(det, signals, ctx);
    expect(signals.products).toHaveLength(0);
    expect(signals.errors[0]).toMatch(/quota/i);
    expect(fetchJsonMock).toHaveBeenCalledTimes(1);
  });

  it("gives up when the job never finishes inside the budget", async () => {
    fetchJsonMock.mockImplementation(async (url: string) => {
      const running = { success: true, status: "running", jobId: "job1", pollAfterSeconds: 1 };
      return { ok: true, status: new URL(url).pathname === "/shopee" ? 202 : 200, data: running, error: null, blocked: false };
    });
    const { det, signals } = thin("https://shopee.com.my/kopikampung");
    await provider.run(det, signals, { ...ctx, config: { ...config, shopeeScraperTimeoutMs: 5_000 } });
    expect(signals.products).toHaveLength(0);
    expect(signals.errors[0]).toMatch(/still running/);
    expect(signals.status).not.toBe("ok");
  });
});
