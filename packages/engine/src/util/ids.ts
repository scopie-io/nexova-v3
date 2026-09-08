import { randomUUID, createHash } from "node:crypto";

export function newId(prefix = ""): string {
  const id = randomUUID().replace(/-/g, "").slice(0, 16);
  return prefix ? `${prefix}_${id}` : id;
}

export function sha256(input: string | Buffer): string {
  return createHash("sha256").update(input).digest("hex");
}

export function shortHash(input: string, length = 8): string {
  return sha256(input).slice(0, length);
}

/** URL-safe, lowercase slug. Keeps unicode letters transliterated only when ASCII-representable. */
export function slugify(input: string, fallback = "item"): string {
  const s = input
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
    .replace(/-+$/g, "");
  return s || fallback;
}

/** Returns a slug that is not in `taken`, appending -2, -3, ... as needed. */
export function uniqueSlug(base: string, taken: Set<string>): string {
  let slug = base;
  let i = 2;
  while (taken.has(slug)) {
    slug = `${base}-${i++}`;
  }
  taken.add(slug);
  return slug;
}
