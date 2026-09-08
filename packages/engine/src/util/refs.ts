import { promises as fs } from "node:fs";

/** Read the bytes behind a storage ref: an https URL (Blob) or an absolute path on disk. */
export async function readRef(ref: string, opts: { timeoutMs?: number; maxBytes?: number } = {}): Promise<Buffer | null> {
  if (/^https?:\/\//i.test(ref)) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(new Error("timeout")), opts.timeoutMs ?? 30_000);
    try {
      const res = await fetch(ref, { signal: ac.signal, redirect: "follow" });
      if (!res.ok) return null;
      const buf = Buffer.from(await res.arrayBuffer());
      if (opts.maxBytes && buf.byteLength > opts.maxBytes) return null;
      return buf;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
  try {
    return await fs.readFile(ref);
  } catch {
    return null;
  }
}

export function isUrlRef(ref: string): boolean {
  return /^https?:\/\//i.test(ref);
}
