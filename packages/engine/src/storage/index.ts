import type { EngineConfig } from "../config.js";
import { FsStorage } from "./fs.js";
import type { Storage } from "./types.js";
import { VercelStorage } from "./vercel.js";

export type { Storage, RecordEntry, PutBytesOptions, PutBytesResult } from "./types.js";
export { FsStorage } from "./fs.js";
export { VercelStorage } from "./vercel.js";

/** Pick the storage backend from configuration: Neon + Blob when both are configured (or forced), disk otherwise. */
export function createStorage(config: EngineConfig): Storage {
  if (config.storage === "vercel") return new VercelStorage(config);
  return new FsStorage(config);
}
