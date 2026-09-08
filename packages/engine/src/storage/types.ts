/**
 * Storage is the one seam between the engine and where its state lives.
 *
 *   records  small JSON documents in named collections (jobs, artifacts, stores, source cache, asset index)
 *   lines    append-only logs (usage ledger, per-job logs)
 *   bytes    files (uploads, captures, downloaded images) addressed by a key and returned as a "ref"
 *
 * A ref is self-describing: an absolute path on disk (FsStorage) or an https URL (VercelStorage), so
 * anything holding a ref can read it back with `readRef()` without knowing which storage produced it.
 *
 * FsStorage keeps today's on-disk layout (data/, stores/) so the CLI, tests and offline mode are unchanged.
 * VercelStorage puts records and lines in Neon Postgres and bytes in Vercel Blob.
 */

export interface RecordEntry<T> {
  key: string;
  value: T;
  updatedAt: string;
}

export interface PutBytesOptions {
  contentType: string;
}

export interface PutBytesResult {
  /** Where the bytes live, readable with readRef(): absolute path or https URL. */
  ref: string;
  /** What to put in a StoreSpec or template: a site-relative path (fs) or a public URL (vercel). */
  url: string;
}

export interface Storage {
  readonly id: "fs" | "vercel";

  init(): Promise<void>;

  get<T = unknown>(collection: string, key: string): Promise<T | null>;
  put(collection: string, key: string, value: unknown): Promise<void>;
  delete(collection: string, key: string): Promise<void>;
  /** Entries in a collection, most recently updated first. */
  list<T = unknown>(collection: string, opts?: { limit?: number }): Promise<Array<RecordEntry<T>>>;
  keys(collection: string): Promise<string[]>;

  append(name: string, line: string): Promise<void>;
  /** All lines of a log, oldest first. */
  lines(name: string): Promise<string[]>;

  putBytes(key: string, data: Uint8Array, opts: PutBytesOptions): Promise<PutBytesResult>;
  /** True when a ref produced by putBytes can still be read. */
  has(ref: string): Promise<boolean>;
}
