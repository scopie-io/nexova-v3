/**
 * FsStorage: the on-disk layout Nexova has always used, so existing data/ and stores/ folders,
 * the CLI and the tests keep working unchanged.
 *
 *   jobs                -> data/jobs/<id>/job.json
 *   artifacts/<jobId>   -> data/jobs/<id>/<name>[.json]
 *   stores              -> stores/<slug>/store.json
 *   store-meta          -> stores/<slug>/store.meta.json
 *   source-cache        -> data/cache/sources/<key>.json
 *   asset-index         -> stores/<slug>/assets/index.json
 *   <other>             -> data/records/<collection>/<key>.json
 *   usage (lines)       -> data/usage/ledger.jsonl
 *   joblog/<id> (lines) -> data/jobs/<id>/log.txt
 *   attachments/<jobId>/<file> (bytes) -> data/jobs/<id>/attachments/<file>
 *   captures/<jobId>/<file>    (bytes) -> data/jobs/<id>/captures/<file>
 *   images/<slug>/<file>       (bytes) -> stores/<slug>/assets/images/<file>, url nexova/images/<file>
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import type { EngineConfig } from "../config.js";
import { appendLine, ensureDir, exists, listDirs, readJsonOrNull, writeJson, writeText } from "../util/fsx.js";
import type { PutBytesOptions, PutBytesResult, RecordEntry, Storage } from "./types.js";

const ASSET_URL_PREFIX = "nexova/images";

export class FsStorage implements Storage {
  readonly id = "fs" as const;
  constructor(private readonly config: EngineConfig) {}

  async init(): Promise<void> {
    await ensureDir(this.config.storesDir);
    await ensureDir(path.join(this.config.dataDir, "jobs"));
    await ensureDir(path.join(this.config.dataDir, "usage"));
  }

  // ---------- records ----------

  private recordFile(collection: string, key: string): string {
    const { dataDir, storesDir } = this.config;
    if (collection === "jobs") return path.join(dataDir, "jobs", key, "job.json");
    if (collection.startsWith("artifacts/")) return path.join(dataDir, "jobs", collection.slice("artifacts/".length), artifactFile(key));
    if (collection === "stores") return path.join(storesDir, key, "store.json");
    if (collection === "store-meta") return path.join(storesDir, key, "store.meta.json");
    if (collection === "source-cache") return path.join(dataDir, "cache", "sources", `${key}.json`);
    if (collection === "asset-index") return path.join(storesDir, key, "assets", "index.json");
    return path.join(dataDir, "records", collection, `${key}.json`);
  }

  private async recordKeys(collection: string): Promise<string[]> {
    const { dataDir, storesDir } = this.config;
    if (collection === "jobs") return listDirs(path.join(dataDir, "jobs"));
    if (collection === "stores" || collection === "store-meta") return listDirs(storesDir);
    if (collection === "source-cache") return listJsonKeys(path.join(dataDir, "cache", "sources"));
    if (collection === "asset-index") return listDirs(storesDir);
    if (collection.startsWith("artifacts/")) {
      const dir = path.join(dataDir, "jobs", collection.slice("artifacts/".length));
      try {
        return (await fs.readdir(dir, { withFileTypes: true })).filter((e) => e.isFile() && e.name !== "job.json" && e.name !== "log.txt").map((e) => e.name.replace(/\.json$/, ""));
      } catch {
        return [];
      }
    }
    return listJsonKeys(path.join(dataDir, "records", collection));
  }

  async get<T = unknown>(collection: string, key: string): Promise<T | null> {
    if (!safeKey(key)) return null;
    const file = this.recordFile(collection, key);
    if (!file.endsWith(".json")) {
      try {
        return (await fs.readFile(file, "utf8")) as unknown as T;
      } catch {
        return null;
      }
    }
    return readJsonOrNull<T>(file);
  }

  async put(collection: string, key: string, value: unknown): Promise<void> {
    if (!safeKey(key)) throw new Error(`invalid record key: ${key}`);
    const file = this.recordFile(collection, key);
    if (typeof value === "string" && !file.endsWith(".json")) await writeText(file, value);
    else await writeJson(file, value);
  }

  async delete(collection: string, key: string): Promise<void> {
    if (!safeKey(key)) return;
    await fs.rm(this.recordFile(collection, key), { force: true });
  }

  async list<T = unknown>(collection: string, opts: { limit?: number } = {}): Promise<Array<RecordEntry<T>>> {
    const out: Array<RecordEntry<T>> = [];
    for (const key of await this.recordKeys(collection)) {
      const file = this.recordFile(collection, key);
      const value = await readJsonOrNull<T>(file);
      if (value == null) continue;
      let updatedAt = "";
      try {
        updatedAt = (await fs.stat(file)).mtime.toISOString();
      } catch {
        /* ignore */
      }
      out.push({ key, value, updatedAt });
    }
    out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return opts.limit ? out.slice(0, opts.limit) : out;
  }

  async keys(collection: string): Promise<string[]> {
    return this.recordKeys(collection);
  }

  // ---------- lines ----------

  private lineFile(name: string): string {
    if (name === "usage") return path.join(this.config.dataDir, "usage", "ledger.jsonl");
    if (name.startsWith("joblog/")) return path.join(this.config.dataDir, "jobs", name.slice("joblog/".length), "log.txt");
    return path.join(this.config.dataDir, "logs", `${name.replace(/[^a-z0-9_-]+/gi, "_")}.log`);
  }

  async append(name: string, line: string): Promise<void> {
    await appendLine(this.lineFile(name), line);
  }

  async lines(name: string): Promise<string[]> {
    try {
      const raw = await fs.readFile(this.lineFile(name), "utf8");
      return raw.split("\n").filter((l) => l.trim());
    } catch {
      return [];
    }
  }

  // ---------- bytes ----------

  /** Absolute path for a bytes key, and the URL a template should use for it. */
  bytesLocation(key: string): { file: string; url: string } {
    const parts = key.split("/");
    const [kind, owner, ...rest] = parts;
    const name = rest.join("/");
    if (!name || !safeKey(owner)) throw new Error(`invalid bytes key: ${key}`);
    if (kind === "images") return { file: path.join(this.config.storesDir, owner, "assets", "images", name), url: `${ASSET_URL_PREFIX}/${name}` };
    if (kind === "attachments" || kind === "captures") {
      const file = path.join(this.config.dataDir, "jobs", owner, kind, name);
      return { file, url: file };
    }
    const file = path.join(this.config.dataDir, "files", kind, owner, name);
    return { file, url: file };
  }

  async putBytes(key: string, data: Uint8Array, _opts: PutBytesOptions): Promise<PutBytesResult> {
    const { file, url } = this.bytesLocation(key);
    await ensureDir(path.dirname(file));
    await fs.writeFile(file, data);
    return { ref: file, url };
  }

  async has(ref: string): Promise<boolean> {
    return exists(ref);
  }
}

/** Text artifacts (research.md, logs) keep their extension; everything else is JSON. */
export function artifactFile(name: string): string {
  return /\.(md|txt|log|html|csv)$/i.test(name) ? name : `${name}.json`;
}

function safeKey(key: string): boolean {
  return /^[a-z0-9][a-z0-9._-]*$/i.test(key) && !key.includes("..");
}

async function listJsonKeys(dir: string): Promise<string[]> {
  try {
    return (await fs.readdir(dir)).filter((n) => n.endsWith(".json")).map((n) => n.slice(0, -5));
  } catch {
    return [];
  }
}
