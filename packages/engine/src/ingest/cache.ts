import path from "node:path";
import type { EngineConfig } from "../config.js";
import { emptySignals, type SourceSignals } from "../schema/signals.js";
import { readJsonOrNull, writeJson } from "../util/fsx.js";
import { sha256 } from "../util/ids.js";

interface CacheEntry {
  savedAt: string;
  version: number;
  signals: SourceSignals;
}

const CACHE_VERSION = 2;

export class SourceCache {
  constructor(private readonly config: EngineConfig) {}

  private file(url: string): string {
    return path.join(this.config.dataDir, "cache", "sources", `${sha256(url).slice(0, 32)}.json`);
  }

  async get(url: string): Promise<SourceSignals | null> {
    if (this.config.cacheTtlHours <= 0) return null;
    const entry = await readJsonOrNull<CacheEntry>(this.file(url));
    if (!entry || (entry.version ?? 1) !== CACHE_VERSION) return null;
    const ageMs = Date.now() - new Date(entry.savedAt).getTime();
    if (ageMs > this.config.cacheTtlHours * 3600_000) return null;
    // Only reuse useful results; blocked/failed sources should be retried.
    if (entry.signals.status === "blocked" || entry.signals.status === "failed") return null;
    const base = emptySignals(entry.signals, entry.signals.input, entry.signals.id);
    return { ...base, ...entry.signals, fromCache: true, screenshots: [] };
  }

  async set(url: string, signals: SourceSignals): Promise<void> {
    if (this.config.cacheTtlHours <= 0) return;
    await writeJson(this.file(url), { savedAt: new Date().toISOString(), version: CACHE_VERSION, signals: { ...signals, fromCache: false } } satisfies CacheEntry, false);
  }
}
