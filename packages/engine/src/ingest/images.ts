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
import sharp, { type Metadata } from "sharp";
import { readRef } from "../util/refs.js";

export const VISION_LONG_EDGE = 1568;
/** Hard ceiling for one image payload (base64 chars) with headroom under the API's 5MB limit. */
export const MAX_BASE64 = 4_600_000;
const TILE_ASPECT = 1.35;
const TILE_OVERLAP = 0.08;
const MAX_TILES = 6;

export type VisionMedia = "image/jpeg" | "image/png";

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
    const tile = await encodeTile(input, null, width, height);
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
      const tile = await encodeTile(input, { left: 0, top, width, height: h }, width, h);
      if (tile) tiles.push({ ...tile, index: tiles.length + 1, total: tileCount });
    }
    for (const t of tiles) t.total = tiles.length;
  }
  const note = tiles.length === 0 ? "could not encode any tile" : tileCount > 1 ? `tall capture split into ${tiles.length} readable parts` : "";
  return { tiles, originalWidth: width, originalHeight: height, note };
}

async function encodeTile(input: Buffer, region: { left: number; top: number; width: number; height: number } | null, width: number, height: number): Promise<Omit<VisionTile, "index" | "total"> | null> {
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
