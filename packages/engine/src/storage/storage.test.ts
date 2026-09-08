import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { loadConfig } from "../config.js";
import { readRef } from "../util/refs.js";
import { FsStorage } from "./fs.js";
import type { Storage } from "./types.js";
import { VercelStorage } from "./vercel.js";

const tmp = mkdtempSync(path.join(os.tmpdir(), "nexova-storage-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

function roundTrip(name: string, make: () => Storage | null) {
  describe(name, () => {
    const storage = make();
    const run = storage ? it : it.skip;
    const stamp = Date.now().toString(36);

    run("stores and lists records, newest first", async () => {
      await storage!.init();
      await storage!.put("jobs", `job_a${stamp}`, { id: "a", createdAt: "2026-01-01" });
      await new Promise((r) => setTimeout(r, 20));
      await storage!.put("jobs", `job_b${stamp}`, { id: "b", createdAt: "2026-01-02" });
      expect(await storage!.get("jobs", `job_a${stamp}`)).toMatchObject({ id: "a" });
      const keys = await storage!.keys("jobs");
      expect(keys).toContain(`job_a${stamp}`);
      const list = await storage!.list<{ id: string }>("jobs", { limit: 2 });
      expect(list[0].value.id).toBe("b");
      await storage!.delete("jobs", `job_a${stamp}`);
      expect(await storage!.get("jobs", `job_a${stamp}`)).toBeNull();
    });

    run("keeps text artifacts as text and json artifacts as json", async () => {
      await storage!.put(`artifacts/job_c${stamp}`, "research.md", "# notes\nhello");
      await storage!.put(`artifacts/job_c${stamp}`, "ingest", { sources: 1 });
      expect(await storage!.get(`artifacts/job_c${stamp}`, "research.md")).toBe("# notes\nhello");
      expect(await storage!.get(`artifacts/job_c${stamp}`, "ingest")).toEqual({ sources: 1 });
    });

    run("appends and reads lines in order", async () => {
      const name = `joblog/job_d${stamp}`;
      await storage!.append(name, "one");
      await storage!.append(name, "two\n");
      expect(await storage!.lines(name)).toEqual(["one", "two"]);
    });

    run("stores bytes and reads them back through the ref", async () => {
      const data = Buffer.from("hello-bytes");
      const { ref, url } = await storage!.putBytes(`attachments/job_e${stamp}/att_1-shot.txt`, data, { contentType: "text/plain" });
      expect(await storage!.has(ref)).toBe(true);
      expect((await readRef(ref))?.toString()).toBe("hello-bytes");
      expect(url).toBeTruthy();
    });
  });
}

roundTrip("FsStorage", () => new FsStorage(loadConfig({ NEXOVA_OFFLINE: "1", NEXOVA_DATA_DIR: path.join(tmp, "data"), NEXOVA_STORES_DIR: path.join(tmp, "stores") }, tmp)));

// Runs only when a real Neon + Blob pair is configured (e.g. `vercel env pull .env.local` then load it).
roundTrip("VercelStorage", () => {
  const env = { ...process.env };
  if (!env.DATABASE_URL || !env.BLOB_READ_WRITE_TOKEN) return null;
  return new VercelStorage(loadConfig({ ...env, NEXOVA_OFFLINE: "1", NEXOVA_STORAGE: "vercel" }, tmp));
});

describe("FsStorage layout", () => {
  it("maps images to the store assets folder with a site-relative url", async () => {
    const storage = new FsStorage(loadConfig({ NEXOVA_OFFLINE: "1", NEXOVA_DATA_DIR: path.join(tmp, "data"), NEXOVA_STORES_DIR: path.join(tmp, "stores") }, tmp));
    const { ref, url } = await storage.putBytes("images/my-shop/hero-abc123.webp", Buffer.from("x"), { contentType: "image/webp" });
    expect(ref).toBe(path.join(tmp, "stores", "my-shop", "assets", "images", "hero-abc123.webp"));
    expect(url).toBe("nexova/images/hero-abc123.webp");
  });
});
