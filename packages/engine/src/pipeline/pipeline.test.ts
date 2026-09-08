/**
 * End-to-end pipeline test with the offline gateway and the starter template.
 * Builds a real site (vite build) into a temp stores dir - takes ~10-20s.
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Engine } from "../index.js";
import { OfflineGateway } from "../claude/offline-gateway.js";
import type { AttachmentVisionInput, GatewayContext } from "../claude/gateway.js";
import type { AttachmentExtract } from "../schema/signals.js";
import type { JobEvent } from "../schema/job.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(here, "..", "..", "..", "..");
let tmp: string;
let engine: Engine;

/** Offline gateway + a fake vision reader, to exercise the screenshot path without an API key. */
class FakeVisionGateway extends OfflineGateway {
  override readonly id = "fake-vision";
  override async extractFromAttachments(input: AttachmentVisionInput, _ctx: GatewayContext): Promise<AttachmentExtract[]> {
    return input.images.map((a) => ({
      attachmentId: a.id,
      name: a.name,
      kind: a.kind,
      platformGuess: "shopee",
      pageType: "product_list",
      shopName: "Kedai Kopi Aman",
      handle: "kopiaman",
      bio: "Kopi from Ipoh",
      followers: 1500,
      rating: 4.9,
      location: "Ipoh",
      contacts: { whatsapp: "60123456789", email: null, phone: null, website: null },
      socialHandles: [],
      products: [
        { title: "Matcha Latte Kit", price: 45, currency: "MYR", priceText: "RM45.00", soldCount: 1200, images: [], via: "vision", evidence: `attachment:${a.id}` },
        { title: "Kuih Bahulu Tin", price: 18, currency: "MYR", priceText: "RM18.00", images: [], via: "vision", evidence: `attachment:${a.id}` },
      ],
      visibleText: "Free shipping over RM100",
      notes: "",
      confidence: 0.9,
      via: "vision",
    }));
  }
}

const PNG_1x1 = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");

beforeAll(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "nexova-test-"));
  engine = await Engine.create({
    rootDir,
    env: { ...process.env, NEXOVA_OFFLINE: "1", ANTHROPIC_API_KEY: "" },
    gateway: new FakeVisionGateway(),
    config: { storesDir: path.join(tmp, "stores"), dataDir: path.join(tmp, "data"), templatesDir: path.join(rootDir, "templates"), publicUrl: "http://localhost:4000", cacheTtlHours: 0, offline: false, discovery: false },
  });
});

afterAll(async () => {
  await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
});

describe("pipeline (offline gateway + fake vision)", () => {
  it("builds a live store from pasted products, a CSV and a screenshot without any network", async () => {
    const events: JobEvent[] = [];
    const csv = "Title,Price,Currency,Category\nHandmade Ceramic Mug,58,MYR,Home\nMatcha Latte Kit,45,MYR,Tea\n";
    const job = await engine.createStore("Kedai Kopi Aman\nKopi Tarik Sachet Box RM 25.90", { slug: "kopi-aman-test", skipResearch: true }, [
      { name: "products.csv", mime: "text/csv", data: Buffer.from(csv) },
      { name: "shopee-list.png", mime: "image/png", data: PNG_1x1 },
    ]);
    expect(job.input.attachments).toHaveLength(2);
    engine.subscribe(job.id, (e) => events.push(e));
    const done = await engine.waitFor(job.id);
    expect(done.error).toBeNull();
    expect(done.status).toBe("done");
    expect(done.slug).toBe("kopi-aman-test");
    expect(done.templateId).toBe("nexova-starter");
    expect(done.siteUrl).toBe("http://localhost:4000/s/kopi-aman-test/");
    const statuses = Object.fromEntries(done.steps.map((s) => [s.name, s.status]));
    expect(statuses).toMatchObject({ detect: "done", ingest: "skipped", discover: "skipped", attachments: "done", research: "skipped", normalize: "done", assets: "done", enrich: "done", template: "done", compose: "done", build: "done", deploy: "done" });

    const coverage = await engine.jobs.getArtifact<{ totals: { products: number }; attachments: { total: number; products: number } }>(done, "coverage");
    expect(coverage?.attachments.total).toBe(2);
    expect(coverage?.attachments.products).toBe(4);
    // CSV (2) + vision (2, one overlapping) + text (1) => 4 unique products after merge
    expect(coverage?.totals.products).toBe(4);

    const spec = await engine.stores.getSpec("kopi-aman-test");
    expect(spec?.brand.name).toBe("Kedai Kopi Aman");
    expect(spec?.commerce.currency).toBe("MYR");
    expect(spec?.brand.contact.whatsapp).toBe("60123456789");
    expect(spec?.commerce.checkout.mode).toBe("whatsapp");
    const titles = spec?.catalog.products.map((p) => p.title) ?? [];
    expect(titles).toEqual(expect.arrayContaining(["Handmade Ceramic Mug", "Matcha Latte Kit", "Kopi Tarik Sachet Box", "Kuih Bahulu Tin"]));
    expect(titles).toHaveLength(4);
    const matcha = spec?.catalog.products.find((p) => p.title === "Matcha Latte Kit");
    expect(matcha?.price.amount).toBe(45);
    expect(matcha?.soldCount).toBe(1200);

    const live = path.join(tmp, "stores", "kopi-aman-test", "live", "index.html");
    const html = await fs.readFile(live, "utf8");
    expect(html).toContain("<title>Kedai Kopi Aman");
    expect(html).toContain("/s/kopi-aman-test/assets/");
    expect(events.some((e) => e.type === "done")).toBe(true);
    expect(events.filter((e) => e.type === "step").length).toBeGreaterThan(12);
  }, 240_000);

  it("supports inventory edits and rebuilds without Claude", async () => {
    const spec = await engine.stores.patchProduct("kopi-aman-test", "matcha-latte-kit", { inventory: { track: true, quantity: 3, status: "low_stock" }, price: { amount: 49, currency: "MYR" } });
    expect(spec.catalog.products.find((p) => p.id === "matcha-latte-kit")?.inventory.quantity).toBe(3);
    await engine.stores.upsertProduct("kopi-aman-test", { title: "Gula Melaka Cookies", price: { amount: 32, currency: "MYR" } });
    const job = await engine.rebuildStore("kopi-aman-test");
    const done = await engine.waitFor(job.id);
    expect(done.status).toBe("done");
    const data = JSON.parse(await fs.readFile(path.join(tmp, "stores", "kopi-aman-test", "site", "src", "nexova", "store.json"), "utf8"));
    expect(data.catalog.products).toHaveLength(5);
    expect(data.catalog.products.find((p: { id: string }) => p.id === "matcha-latte-kit").price.amount).toBe(49);
  }, 240_000);

  it("fails cleanly on empty input", async () => {
    const job = await engine.createStore("   \n  ");
    const done = await engine.waitFor(job.id);
    expect(done.status).toBe("failed");
    expect(done.error).toMatch(/Paste at least one link/);
  });
});
