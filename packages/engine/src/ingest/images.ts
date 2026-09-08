/**
 * Image preparation for vision.
 *
 * Merchant screenshots and full-page browser captures are often far outside what a vision call
 * can accept or read well: a 1366x14000 storefront capture is 4MB+, and simply scaling it to fit
 * makes the text unreadable. So tall images are split into overlapping, readable tiles, and every
 * tile is resized to the model's effective resolution and re-encoded as JPEG.
 *
 * Claude downsamples anything larger than ~1568px on the long edge, so that is the target.
 */
import type { Metadata, Sharp, SharpOptions } from "sharp";
import { readRef } from "../util/refs.js";

type SharpFactory = (input: Buffer, options?: SharpOptions) => Sharp;
let sharpPromise: Promise<SharpFactory | null> | null = null;

/**
 * sharp is a native module. Where its binary is missing for the running platform (a function
 * built on x64 but executed on arm64, for instance) we degrade to sending images untouched
 * rather than crashing every step that merely imports this module.
 */
async function loadSharp(): Promise<SharpFactory | null> {
  if (!sharpPromise) {
    sharpPromise = import("sharp")
      .then((m) => (m.default ?? m) as unknown as SharpFactory)
      .catch(() => null);
  }
  return sharpPromise;
}

const MAGIC: Array<[VisionMedia, (b: Buffer) => boolean]> = [
  ["image/png", (b) => b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47],
  ["image/jpeg", (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff],
  ["image/webp", (b) => b.length > 12 && b.toString("ascii", 0, 4) === "RIFF" && b.toString("ascii", 8, 12) === "WEBP"],
  ["image/gif", (b) => b.length > 6 && b.toString("ascii", 0, 3) === "GIF"],
];

/** Fallback without sharp: one tile of the original bytes when the format and size allow it. */
function rawTile(input: Buffer): PrepareResult {
  const media = MAGIC.find(([, test]) => test(input))?.[0];
  if (!media) return { tiles: [], originalWidth: 0, originalHeight: 0, note: "unsupported image format (sharp unavailable)" };
  const base64 = input.toString("base64");
  if (base64.length > MAX_BASE64) return { tiles: [], originalWidth: 0, originalHeight: 0, note: "image too large to send unresized (sharp unavailable)" };
  return { tiles: [{ base64, media, index: 1, total: 1, width: 0, height: 0 }], originalWidth: 0, originalHeight: 0, note: "sent unresized (sharp unavailable)" };
}

export const VISION_LONG_EDGE = 1568;
/** Hard ceiling for one image payload (base64 chars) with headroom under the API's 5MB limit. */
export const MAX_BASE64 = 4_600_000;
const TILE_ASPECT = 1.35;
const TILE_OVERLAP = 0.08;
const MAX_TILES = 6;

export type VisionMedia = "image/jpeg" | "image/png" | "image/webp" | "image/gif";

export interface VisionTile {
  base64: string;
  media: VisionMedia;
  /** 1-based tile index and total, for labelling multi-part screenshots. */
  index: number;
  total: number;
  width: number;
  height: number;
}

export interface PrepareResult {
  tiles: VisionTile[];
  originalWidth: number;
  originalHeight: number;
  note: string;
}

/**
 * Turn an image file into one or more vision-ready tiles.
 * Returns an empty tile list (with a note) when the file cannot be read as an image.
 */
export async function prepareForVision(source: string | Buffer, opts: { maxTiles?: number } = {}): Promise<PrepareResult> {
  const maxTiles = Math.max(1, Math.min(opts.maxTiles ?? MAX_TILES, MAX_TILES));
  const input = Buffer.isBuffer(source) ? source : await readRef(source);
  if (!input) return { tiles: [], originalWidth: 0, originalHeight: 0, note: `unreadable image: ${typeof source === "string" ? source.slice(0, 120) : "empty buffer"}` };
  const sharp = await loadSharp();
  if (!sharp) return rawTile(input);
  let meta: Metadata;
  try {
    meta = await sharp(input).metadata();
  } catch (err) {
    return { tiles: [], originalWidth: 0, originalHeight: 0, note: `not a decodable image: ${err instanceof Error ? err.message : String(err)}` };
  }
  const width = meta.width ?? 0;
  const height = meta.height ?? 0;
  if (!width || !height) return { tiles: [], originalWidth: width, originalHeight: height, note: "image has no dimensions" };

  const ratio = height / width;
  const tileCount = ratio > TILE_ASPECT * 1.2 ? Math.min(maxTiles, Math.max(1, Math.round(ratio / TILE_ASPECT))) : 1;

  const tiles: VisionTile[] = [];
  if (tileCount === 1) {
    const tile = await encodeTile(sharp, input, null, width, height);
    if (tile) tiles.push({ ...tile, index: 1, total: 1 });
  } else {
    // Overlapping horizontal bands so a product card split by a cut still appears whole in one tile.
    const band = Math.ceil(height / tileCount);
    const overlap = Math.round(band * TILE_OVERLAP);
    for (let i = 0; i < tileCount; i++) {
      const top = Math.max(0, i * band - (i > 0 ? overlap : 0));
      const bottom = Math.min(height, (i + 1) * band + overlap);
      const h = bottom - top;
      if (h < 40) continue;
      const tile = await encodeTile(sharp, input, { left: 0, top, width, height: h }, width, h);
      if (tile) tiles.push({ ...tile, index: tiles.length + 1, total: tileCount });
    }
    for (const t of tiles) t.total = tiles.length;
  }
  const note = tiles.length === 0 ? "could not encode any tile" : tileCount > 1 ? `tall capture split into ${tiles.length} readable parts` : "";
  return { tiles, originalWidth: width, originalHeight: height, note };
}

async function encodeTile(sharp: SharpFactory, input: Buffer, region: { left: number; top: number; width: number; height: number } | null, width: number, height: number): Promise<Omit<VisionTile, "index" | "total"> | null> {
  const longEdge = Math.max(width, height);
  const scale = longEdge > VISION_LONG_EDGE ? VISION_LONG_EDGE / longEdge : 1;
  const targetW = Math.max(1, Math.round(width * scale));
  for (const quality of [86, 72, 58, 44]) {
    try {
      let pipeline = sharp(input, { failOn: "none", limitInputPixels: 800_000_000 });
      if (region) pipeline = pipeline.extract(region);
      const buf = await pipeline
        .resize({ width: targetW, withoutEnlargement: true })
        .jpeg({ quality, mozjpeg: true })
        .toBuffer();
      const base64 = buf.toString("base64");
      if (base64.length <= MAX_BASE64) {
        return { base64, media: "image/jpeg", width: targetW, height: Math.round(height * scale) };
      }
    } catch {
      return null;
    }
  }
  return null;
}
