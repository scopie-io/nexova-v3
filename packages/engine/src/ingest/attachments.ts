/**
 * Attachments: screenshots (TikTok Shop, Shopee, Instagram grids, WhatsApp catalogs), CSV/TSV/JSON
 * product exports, price lists. Spreadsheets are parsed locally; images go to Claude vision.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import type { Attachment, AttachmentExtract, AttachmentKind, RawProduct } from "../schema/signals.js";
import { ensureDir } from "../util/fsx.js";
import { newId, slugify } from "../util/ids.js";
import { guessCurrencyFromText, parsePrice } from "../util/text.js";

export interface IncomingFile {
  name: string;
  mime: string;
  data: Buffer | Uint8Array;
}

export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
export const MAX_ATTACHMENTS = 30;

const IMAGE_MIMES = new Set(["image/png", "image/jpeg", "image/jpg", "image/webp", "image/gif"]);

export function kindFor(name: string, mime: string): AttachmentKind {
  const ext = path.extname(name).toLowerCase();
  if (IMAGE_MIMES.has(mime) || [".png", ".jpg", ".jpeg", ".webp", ".gif"].includes(ext)) return "image";
  if (mime === "text/csv" || [".csv", ".tsv"].includes(ext)) return "csv";
  if (mime === "application/json" || ext === ".json") return "json";
  if (mime === "application/pdf" || ext === ".pdf") return "pdf";
  if (mime.startsWith("text/") || [".txt", ".md"].includes(ext)) return "text";
  return "other";
}

export function mimeFor(kind: AttachmentKind, name: string, mime: string): string {
  if (kind === "image") {
    const ext = path.extname(name).toLowerCase();
    if (IMAGE_MIMES.has(mime) && mime !== "image/jpg") return mime;
    return ext === ".png" ? "image/png" : ext === ".webp" ? "image/webp" : ext === ".gif" ? "image/gif" : "image/jpeg";
  }
  return mime || "application/octet-stream";
}

/** Persist uploaded files under a job directory and describe them. */
export async function saveAttachments(files: IncomingFile[], dir: string, origin: Attachment["origin"] = "user"): Promise<Attachment[]> {
  await ensureDir(dir);
  const out: Attachment[] = [];
  for (const f of files.slice(0, MAX_ATTACHMENTS)) {
    if (!f.data || f.data.byteLength === 0 || f.data.byteLength > MAX_ATTACHMENT_BYTES) continue;
    const kind = kindFor(f.name, f.mime);
    if (kind === "other") continue;
    const id = newId("att");
    const safeName = slugify(path.basename(f.name, path.extname(f.name)), "file").slice(0, 40) + (path.extname(f.name).toLowerCase() || (kind === "image" ? ".png" : ""));
    const dest = path.join(dir, `${id}-${safeName}`);
    await fs.writeFile(dest, f.data);
    out.push({ id, name: f.name, mime: mimeFor(kind, f.name, f.mime), kind, path: dest, size: f.data.byteLength, origin });
  }
  return out;
}

// ---------- tabular parsing ----------

export function parseCsv(text: string, delimiter?: string): string[][] {
  const delim = delimiter ?? (text.split("\n")[0]?.includes("\t") ? "\t" : text.split("\n")[0]?.split(";").length > text.split("\n")[0]?.split(",").length ? ";" : ",");
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === delim) {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      if (row.some((c) => c.trim())) rows.push(row);
      row = [];
      field = "";
    } else field += ch;
  }
  row.push(field);
  if (row.some((c) => c.trim())) rows.push(row);
  return rows;
}

const HEADER_ALIASES: Record<string, RegExp> = {
  title: /^(title|name|product|product[ _-]?name|item|item[ _-]?name|nama|produk|nama produk)$/i,
  price: /^(price|harga|selling[ _-]?price|sale[ _-]?price|unit[ _-]?price|amount|rrp)$/i,
  compareAtPrice: /^(compare[ _-]?at[ _-]?price|original[ _-]?price|was|rrp|list[ _-]?price|harga asal)$/i,
  currency: /^(currency|curr|mata wang)$/i,
  description: /^(description|desc|details|body|body[ _-]?html|keterangan|deskripsi)$/i,
  image: /^(image|images|image[ _-]?src|image[ _-]?url|photo|photos|picture|gambar|img)$/i,
  sku: /^(sku|code|product[ _-]?code|kod)$/i,
  stock: /^(stock|qty|quantity|inventory|inventory[ _-]?quantity|available|stok|kuantiti)$/i,
  category: /^(category|categories|type|product[ _-]?type|collection|kategori)$/i,
  url: /^(url|link|product[ _-]?url|handle)$/i,
  tags: /^(tags|tag|labels)$/i,
  variant: /^(variant|variation|option|option1[ _-]?value|size|color|colour|saiz|warna)$/i,
};

function mapHeader(h: string): string | null {
  const clean = h.trim().replace(/^﻿/, "");
  for (const [key, re] of Object.entries(HEADER_ALIASES)) if (re.test(clean)) return key;
  return null;
}

export function productsFromTable(rows: string[][], evidence: string): RawProduct[] {
  if (rows.length < 2) return [];
  const header = rows[0].map(mapHeader);
  const titleIdx = header.indexOf("title");
  if (titleIdx < 0) return [];
  const idx = (k: string) => header.indexOf(k);
  const out: RawProduct[] = [];
  const byTitle = new Map<string, RawProduct>();
  for (const r of rows.slice(1)) {
    const title = (r[titleIdx] ?? "").trim();
    if (!title) continue;
    const priceRaw = idx("price") >= 0 ? r[idx("price")] ?? "" : "";
    const price = priceRaw ? parsePrice(priceRaw) : null;
    const currency = (idx("currency") >= 0 ? (r[idx("currency")] ?? "").trim().toUpperCase() : "") || guessCurrencyFromText(priceRaw) || null;
    const images = idx("image") >= 0 ? (r[idx("image")] ?? "").split(/[,\s|]+/).filter((u) => /^https?:/.test(u)) : [];
    const variantLabel = idx("variant") >= 0 ? (r[idx("variant")] ?? "").trim() : "";
    const existing = byTitle.get(title.toLowerCase());
    if (existing) {
      // Shopify-style exports repeat the title per variant row
      existing.variants = existing.variants ?? [];
      existing.variants.push({ title: variantLabel || `Variant ${existing.variants.length + 1}`, price, sku: idx("sku") >= 0 ? r[idx("sku")] || null : null, image: images[0] ?? null, stock: idx("stock") >= 0 ? parsePrice(r[idx("stock")] ?? "") : null });
      existing.images = [...new Set([...(existing.images ?? []), ...images])];
      if (existing.price == null && price != null) existing.price = price;
      continue;
    }
    const p: RawProduct = {
      title,
      description: idx("description") >= 0 ? (r[idx("description")] ?? "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim() || null : null,
      price,
      priceText: priceRaw || null,
      currency,
      compareAtPrice: idx("compareAtPrice") >= 0 ? parsePrice(r[idx("compareAtPrice")] ?? "") : null,
      images,
      externalId: idx("sku") >= 0 ? r[idx("sku")] || null : null,
      stock: idx("stock") >= 0 ? parsePrice(r[idx("stock")] ?? "") : null,
      category: idx("category") >= 0 ? r[idx("category")] || null : null,
      url: idx("url") >= 0 && /^https?:/.test(r[idx("url")] ?? "") ? r[idx("url")] : null,
      tags: idx("tags") >= 0 ? (r[idx("tags")] ?? "").split(/[,;|]/).map((t) => t.trim()).filter(Boolean) : [],
      variants: variantLabel ? [{ title: variantLabel, price, sku: idx("sku") >= 0 ? r[idx("sku")] || null : null, image: images[0] ?? null, stock: null }] : undefined,
      via: "csv",
      evidence,
    };
    byTitle.set(title.toLowerCase(), p);
    out.push(p);
  }
  return out;
}

export function productsFromJsonFile(json: unknown, evidence: string): RawProduct[] {
  const arr = Array.isArray(json) ? json : json && typeof json === "object" ? ((json as Record<string, unknown>).products ?? (json as Record<string, unknown>).items ?? (json as Record<string, unknown>).data) : null;
  if (!Array.isArray(arr)) return [];
  const rows: string[][] = [];
  const keys = [...new Set(arr.flatMap((o) => (o && typeof o === "object" ? Object.keys(o as object) : [])))];
  if (!keys.length) return [];
  rows.push(keys);
  for (const o of arr) {
    if (!o || typeof o !== "object") continue;
    rows.push(keys.map((k) => {
      const v = (o as Record<string, unknown>)[k];
      if (v == null) return "";
      if (Array.isArray(v)) return v.map((x) => (typeof x === "object" && x && "src" in (x as object) ? String((x as { src: unknown }).src) : String(x))).join(" ");
      if (typeof v === "object") return String((v as { amount?: unknown; src?: unknown }).amount ?? (v as { src?: unknown }).src ?? "");
      return String(v);
    }));
  }
  return productsFromTable(rows, evidence);
}

/** Parse non-image attachments locally (no Claude needed). */
export async function extractLocalAttachments(attachments: Attachment[]): Promise<AttachmentExtract[]> {
  const out: AttachmentExtract[] = [];
  for (const a of attachments) {
    if (a.kind !== "csv" && a.kind !== "json" && a.kind !== "text") continue;
    try {
      const text = await fs.readFile(a.path, "utf8");
      let products: RawProduct[] = [];
      let via: AttachmentExtract["via"] = "text";
      if (a.kind === "csv") {
        products = productsFromTable(parseCsv(text), `attachment:${a.id}`);
        via = "csv";
      } else if (a.kind === "json") {
        products = productsFromJsonFile(JSON.parse(text), `attachment:${a.id}`);
        via = "json";
      }
      out.push({
        attachmentId: a.id,
        name: a.name,
        kind: a.kind,
        platformGuess: "text",
        pageType: a.kind === "text" ? "other" : "spreadsheet",
        shopName: null,
        handle: null,
        bio: null,
        followers: null,
        rating: null,
        location: null,
        contacts: { whatsapp: null, email: null, phone: null, website: null },
        socialHandles: [],
        products,
        visibleText: a.kind === "text" ? text.slice(0, 6000) : "",
        notes: products.length ? `${products.length} products parsed from ${a.kind}` : a.kind === "text" ? "free text attached" : "no product columns recognized (need a title/name column)",
        confidence: products.length ? 0.95 : 0.3,
        via,
      });
    } catch (err) {
      out.push({ attachmentId: a.id, name: a.name, kind: a.kind, platformGuess: "unknown", pageType: "other", shopName: null, handle: null, bio: null, followers: null, rating: null, location: null, contacts: { whatsapp: null, email: null, phone: null, website: null }, socialHandles: [], products: [], visibleText: "", notes: `could not parse: ${err instanceof Error ? err.message : String(err)}`, confidence: 0, via: "none" });
    }
  }
  return out;
}

export function imageAttachments(attachments: Attachment[]): Attachment[] {
  return attachments.filter((a) => a.kind === "image");
}
