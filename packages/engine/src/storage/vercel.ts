/**
 * VercelStorage: records and logs in Neon Postgres, bytes in Vercel Blob.
 *
 * Two generic tables keep the schema tiny and let every engine collection share them:
 *
 *   nexova_records(collection, key, value jsonb, updated_at)   primary key (collection, key)
 *   nexova_lines(id, name, line, at)                           index (name, id)
 *
 * Blob objects are public (storefront images must be), stored under deterministic keys so a
 * re-download overwrites rather than duplicates. Attachments get an unguessable prefix.
 */
import { neon, type NeonQueryFunction } from "@neondatabase/serverless";
import { del, head, put } from "@vercel/blob";
import type { EngineConfig } from "../config.js";
import type { PutBytesOptions, PutBytesResult, RecordEntry, Storage } from "./types.js";

export class VercelStorage implements Storage {
  readonly id = "vercel" as const;
  private readonly sql: NeonQueryFunction<false, false>;
  private readonly blobToken: string;
  private ready: Promise<void> | null = null;

  constructor(config: EngineConfig) {
    if (!config.databaseUrl) throw new Error("VercelStorage needs DATABASE_URL");
    if (!config.blobToken) throw new Error("VercelStorage needs BLOB_READ_WRITE_TOKEN");
    this.sql = neon(config.databaseUrl);
    this.blobToken = config.blobToken;
  }

  async init(): Promise<void> {
    if (!this.ready) {
      this.ready = (async () => {
        await this.sql.query(`CREATE TABLE IF NOT EXISTS nexova_records (
          collection text NOT NULL,
          key text NOT NULL,
          value jsonb NOT NULL,
          updated_at timestamptz NOT NULL DEFAULT now(),
          PRIMARY KEY (collection, key)
        )`);
        await this.sql.query(`CREATE INDEX IF NOT EXISTS nexova_records_collection_updated ON nexova_records (collection, updated_at DESC)`);
        await this.sql.query(`CREATE TABLE IF NOT EXISTS nexova_lines (
          id bigserial PRIMARY KEY,
          name text NOT NULL,
          line text NOT NULL,
          at timestamptz NOT NULL DEFAULT now()
        )`);
        await this.sql.query(`CREATE INDEX IF NOT EXISTS nexova_lines_name_id ON nexova_lines (name, id)`);
      })();
    }
    await this.ready;
  }

  // ---------- records ----------

  async get<T = unknown>(collection: string, key: string): Promise<T | null> {
    await this.init();
    const rows = (await this.sql.query(`SELECT value FROM nexova_records WHERE collection = $1 AND key = $2`, [collection, key])) as Array<{ value: T }>;
    return rows[0]?.value ?? null;
  }

  async put(collection: string, key: string, value: unknown): Promise<void> {
    await this.init();
    await this.sql.query(
      `INSERT INTO nexova_records (collection, key, value, updated_at) VALUES ($1, $2, $3::jsonb, now())
       ON CONFLICT (collection, key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [collection, key, JSON.stringify(value)],
    );
  }

  async delete(collection: string, key: string): Promise<void> {
    await this.init();
    await this.sql.query(`DELETE FROM nexova_records WHERE collection = $1 AND key = $2`, [collection, key]);
  }

  async list<T = unknown>(collection: string, opts: { limit?: number } = {}): Promise<Array<RecordEntry<T>>> {
    await this.init();
    const rows = (await this.sql.query(`SELECT key, value, updated_at FROM nexova_records WHERE collection = $1 ORDER BY updated_at DESC LIMIT $2`, [collection, opts.limit ?? 1000])) as Array<{ key: string; value: T; updated_at: string | Date }>;
    return rows.map((r) => ({ key: r.key, value: r.value, updatedAt: new Date(r.updated_at).toISOString() }));
  }

  async keys(collection: string): Promise<string[]> {
    await this.init();
    const rows = (await this.sql.query(`SELECT key FROM nexova_records WHERE collection = $1`, [collection])) as Array<{ key: string }>;
    return rows.map((r) => r.key);
  }

  // ---------- lines ----------

  async append(name: string, line: string): Promise<void> {
    await this.init();
    await this.sql.query(`INSERT INTO nexova_lines (name, line) VALUES ($1, $2)`, [name, line.replace(/\n$/, "")]);
  }

  async lines(name: string): Promise<string[]> {
    await this.init();
    const rows = (await this.sql.query(`SELECT line FROM nexova_lines WHERE name = $1 ORDER BY id ASC`, [name])) as Array<{ line: string }>;
    return rows.map((r) => r.line);
  }

  // ---------- bytes ----------

  async putBytes(key: string, data: Uint8Array, opts: PutBytesOptions): Promise<PutBytesResult> {
    const blob = await put(key, Buffer.from(data), { access: "public", contentType: opts.contentType, addRandomSuffix: false, allowOverwrite: true, token: this.blobToken });
    return { ref: blob.url, url: blob.url };
  }

  async has(ref: string): Promise<boolean> {
    if (!/^https?:\/\//i.test(ref)) return false;
    try {
      await head(ref, { token: this.blobToken });
      return true;
    } catch {
      return false;
    }
  }

  async remove(ref: string): Promise<void> {
    await del(ref, { token: this.blobToken });
  }
}
