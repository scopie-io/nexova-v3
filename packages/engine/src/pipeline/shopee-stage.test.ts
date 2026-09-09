/**
 * stageShopeeCatalog decides whether to spend money on a slow, billed scrape. These tests cover
 * the short-circuit paths, which is where that decision lives; the rebuild tail it runs on success
 * is the same one the first pass runs and is covered by pipeline.test.ts.
 */
import { describe, expect, it, vi } from "vitest";
import { loadConfig } from "../config.js";
import { emptySignals, type SourceSignals } from "../schema/signals.js";
import { classifyUrl } from "../ingest/detect.js";

const { runMock, supportsMock } = vi.hoisted(() => ({ runMock: vi.fn(), supportsMock: vi.fn() }));
vi.mock("../ingest/providers/shopee-scraper-api.js", () => ({
  shopeeScraperProvider: { id: "shopee-scraper-api", priority: 40, stage: "fallback", supports: supportsMock, run: runMock },
}));

const { stageShopeeCatalog } = await import("./stages.js");

function sourceFor(url: string, products = 0): SourceSignals {
  const det = classifyUrl(url)!;
  const s = emptySignals(det, det.url, "src_test");
  for (let i = 0; i < products; i++) s.products.push({ title: `Existing ${i}`, via: "shopee-api" });
  if (products) s.status = "ok";
  return s;
}

function ctxFor(sources: SourceSignals[], overrides: Record<string, unknown> = {}) {
  const artifacts = new Map<string, unknown>([["sources", sources]]);
  const log = { debug() {}, info() {}, warn() {}, error() {}, child: () => log };
  const job = { id: "job_test", slug: "s", siteUrl: null, input: { options: {} } };
  return {
    ctx: {
      job,
      log,
      publish: vi.fn(),
      signal: undefined,
      deps: {
        config: { ...loadConfig({ NEXOVA_OFFLINE: "1", RAPIDAPI_KEY: "test-key-1234567890abcdef", NEXOVA_SHOPEE_SCRAPER: "1" }), ...overrides },
        jobs: {
          captureDir: () => "/tmp/cap",
          getArtifact: async (_j: unknown, name: string) => artifacts.get(name) ?? null,
          putArtifact: async (_j: unknown, name: string, v: unknown) => void artifacts.set(name, v),
          save: async () => {},
        },
      },
    },
    artifacts,
  };
}

describe("stageShopeeCatalog", () => {
  // Measured yield is 1-2 products per shop however many are asked for, at ~16 billed calls and
  // ~205s each, so the scrape is opt-in until that changes.
  it("is off unless NEXOVA_SHOPEE_SCRAPER=1", async () => {
    supportsMock.mockReturnValue(true);
    runMock.mockReset();
    const { ctx } = ctxFor([sourceFor("https://shopee.com.my/kopikampung")], { shopeeScraper: false });
    expect(await stageShopeeCatalog(ctx as never)).toEqual({ skip: "disabled (NEXOVA_SHOPEE_SCRAPER=1 to enable)" });
    expect(runMock).not.toHaveBeenCalled();
  });

  it("spends nothing without a key", async () => {
    supportsMock.mockReturnValue(true);
    runMock.mockReset();
    const { ctx } = ctxFor([sourceFor("https://shopee.com.my/kopikampung")], { rapidApiKey: null });
    expect(await stageShopeeCatalog(ctx as never)).toEqual({ skip: "no RAPIDAPI_KEY" });
    expect(runMock).not.toHaveBeenCalled();
  });

  it("spends nothing when no source is Shopee", async () => {
    supportsMock.mockReturnValue(false);
    runMock.mockReset();
    const { ctx } = ctxFor([sourceFor("https://www.tiktok.com/@goli")]);
    expect(await stageShopeeCatalog(ctx as never)).toEqual({ skip: "no Shopee source" });
    expect(runMock).not.toHaveBeenCalled();
  });

  it("spends nothing when the free providers already read the shop", async () => {
    supportsMock.mockReturnValue(true);
    runMock.mockReset();
    // 5 products and status ok: isThinSource is false, so the paid scrape is pointless
    const { ctx } = ctxFor([sourceFor("https://shopee.com.my/kopikampung", 5)]);
    expect(await stageShopeeCatalog(ctx as never)).toEqual({ skip: "Shopee sources already read" });
    expect(runMock).not.toHaveBeenCalled();
  });

  it("scrapes a thin shop and reports when the scrape found nothing, leaving the store alone", async () => {
    supportsMock.mockReturnValue(true);
    runMock.mockReset();
    // what /shop/<id> actually did: a clean job that matched no products
    runMock.mockImplementation(async (_src, signals: SourceSignals) => void signals.errors.push("shopee-scraper-api: job returned 0 row(s), none usable"));
    const source = sourceFor("https://shopee.com.my/kopikampung");
    const { ctx, artifacts } = ctxFor([source]);
    expect(await stageShopeeCatalog(ctx as never)).toEqual({ skip: "1 Shopee source(s) scraped, no products" });
    expect(runMock).toHaveBeenCalledTimes(1);
    // sources are still persisted so the error trail survives into the coverage report
    expect((artifacts.get("sources") as SourceSignals[])[0].errors).toHaveLength(1);
    expect(artifacts.has("ingest")).toBe(false); // no rebuild
  });

  it("scrapes each thin Shopee source one at a time", async () => {
    supportsMock.mockReturnValue(true);
    runMock.mockReset();
    let inFlight = 0;
    let overlapped = false;
    runMock.mockImplementation(async () => {
      inFlight++;
      if (inFlight > 1) overlapped = true;
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
    });
    const { ctx } = ctxFor([sourceFor("https://shopee.com.my/a"), sourceFor("https://shopee.com.my/b")]);
    await stageShopeeCatalog(ctx as never);
    expect(runMock).toHaveBeenCalledTimes(2);
    // every poll is billed, so overlapping scrapes would just multiply the spend
    expect(overlapped).toBe(false);
  });
});
