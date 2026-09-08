import type { EngineConfig } from "../config.js";
import { emptySignals, type SourceSignals } from "../schema/signals.js";
import type { Storage } from "../storage/types.js";
import { sha256 } from "../util/ids.js";
import { isThinSource } from "./providers/types.js";

interface CacheEntry {
  savedAt: string;
  version: number;
  signals: SourceSignals;
}

const CACHE_VERSION = 2;

export class SourceCache {
  constructor(
    private readonly config: EngineConfig,
    private readonly storage: Storage,
  ) {}

  private key(url: string): string {
    return sha256(url).slice(0, 32);
  }

  async get(url: string): Promise<SourceSignals | null> {
    if (this.config.cacheTtlHours <= 0) return null;
    const entry = await this.storage.get<CacheEntry>("source-cache", this.key(url));
    if (!entry || (entry.version ?? 1) !== CACHE_VERSION) return null;
    const ageMs = Date.now() - new Date(entry.savedAt).getTime();
    if (ageMs > this.config.cacheTtlHours * 3600_000) return null;
    // Only reuse useful results; blocked/failed/thin sources should be retried (a shop that yielded
    // nothing may succeed next time, e.g. once an API quota resets or a platform stops rate-limiting).
    if (entry.signals.status === "blocked" || entry.signals.status === "failed" || isThinSource(entry.signals)) return null;
    const base = emptySignals(entry.signals, entry.signals.input, entry.signals.id);
    return { ...base, ...entry.signals, fromCache: true, screenshots: [] };
  }

  async set(url: string, signals: SourceSignals): Promise<void> {
    if (this.config.cacheTtlHours <= 0) return;
    await this.storage.put("source-cache", this.key(url), { savedAt: new Date().toISOString(), version: CACHE_VERSION, signals: { ...signals, fromCache: false } } satisfies CacheEntry);
  }
}
