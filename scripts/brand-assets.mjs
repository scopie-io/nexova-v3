#!/usr/bin/env node
/**
 * Regenerate the decorative brand art in packages/web/public/brand from fal.ai (Recraft V3).
 * Local-only: reads FAL_KEY from .env, never runs during a build. The outputs are committed,
 * so this only needs running when the art should change.
 *
 *   node scripts/brand-assets.mjs           # only makes what is missing
 *   node scripts/brand-assets.mjs --force   # regenerate everything
 *   node scripts/brand-assets.mjs og-cover  # regenerate one asset by name
 *
 * Palette is locked to the nexova.my brand colours via Recraft's `colors` input so the art
 * always sits with the teal/purple/navy tokens in packages/web/src/styles.css.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(root, "packages", "web", "public", "brand");
const ENDPOINT = "https://fal.run/fal-ai/recraft/v3/text-to-image";
const REMBG = "https://fal.run/fal-ai/imageutils/rembg";

/** Brand colours Recraft should draw with (teal, purple, navy). */
const PALETTE = [
  { r: 95, g: 199, b: 205 },
  { r: 130, g: 115, b: 181 },
  { r: 69, g: 82, b: 99 },
];

const ASSETS = [
  {
    name: "hero-moon",
    file: "hero-moon.webp",
    width: 900,
    prompt:
      "A crescent moon and a scattering of small four-point sparkle stars, flat minimal vector shapes, " +
      "pale teal and soft lavender only, thin deep navy outlines, generous empty space around the shapes, " +
      "no scenery, no clouds, no ground, no text, pure white background.",
    image_size: "square_hd",
    style: "vector_illustration",
  },
  {
    name: "hero-rocket",
    file: "hero-rocket.webp",
    width: 700,
    prompt:
      "A small rocket tilted upward with a short trailing swoosh and two tiny sparkle stars, flat minimal " +
      "vector shapes, pale teal and soft lavender only, thin deep navy outlines, generous empty space " +
      "around the shapes, no scenery, no clouds, no ground, no text, pure white background.",
    image_size: "square_hd",
    style: "vector_illustration",
  },
  {
    name: "og-cover",
    file: "og-cover.png",
    width: 1200,
    height: 630,
    dir: path.join(root, "packages", "web", "public"),
    prompt:
      "A clean modern social banner illustration: a stylised rocket rising past a crescent moon and small stars, " +
      "flat minimal shapes in teal, lavender and deep navy on a soft off-white background, generous negative space " +
      "on the left half, no text, no lettering, no logos.",
    image_size: "landscape_16_9",
    style: "digital_illustration/hand_drawn",
  },
];

async function falKey() {
  const raw = await fs.readFile(path.join(root, ".env"), "utf8").catch(() => "");
  const m = raw.match(/^FAL_KEY=(.*)$/m);
  const key = (process.env.FAL_KEY || (m ? m[1] : "")).trim().replace(/^["']|["']$/g, "");
  if (!key) throw new Error("FAL_KEY not found in the environment or .env");
  return key;
}

async function generate(asset, key) {
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: { authorization: `Key ${key}`, "content-type": "application/json" },
    body: JSON.stringify({
      prompt: asset.prompt,
      image_size: asset.image_size,
      style: asset.style,
      colors: PALETTE,
    }),
  });
  if (!res.ok) throw new Error(`fal ${res.status}: ${(await res.text()).slice(0, 400)}`);
  const json = await res.json();
  let url = json?.images?.[0]?.url;
  if (!url) throw new Error(`fal returned no image: ${JSON.stringify(json).slice(0, 400)}`);
  if (asset.cutout) url = await cutout(url, key);
  const img = await fetch(url);
  if (!img.ok) throw new Error(`downloading ${url} failed: ${img.status}`);
  return Buffer.from(await img.arrayBuffer());
}

/** Drop the background so hero art can sit over the page rather than in a box of its own. */
async function cutout(imageUrl, key) {
  const res = await fetch(REMBG, {
    method: "POST",
    headers: { authorization: `Key ${key}`, "content-type": "application/json" },
    body: JSON.stringify({ image_url: imageUrl }),
  });
  if (!res.ok) throw new Error(`fal rembg ${res.status}: ${(await res.text()).slice(0, 400)}`);
  const json = await res.json();
  const url = json?.image?.url;
  if (!url) throw new Error(`fal rembg returned no image: ${JSON.stringify(json).slice(0, 400)}`);
  return url;
}

async function write(asset, raw) {
  const dir = asset.dir ?? outDir;
  await fs.mkdir(dir, { recursive: true });
  const dest = path.join(dir, asset.file);
  let pipeline = sharp(raw).resize({
    width: asset.width,
    height: asset.height,
    fit: asset.height ? "cover" : "inside",
    withoutEnlargement: true,
  });
  pipeline = asset.file.endsWith(".webp") ? pipeline.webp({ quality: 82 }) : pipeline.png({ quality: 85, compressionLevel: 9 });
  await pipeline.toFile(dest);
  const { size } = await fs.stat(dest);
  return { dest, size };
}

async function main() {
  const args = process.argv.slice(2);
  const force = args.includes("--force");
  const only = args.filter((a) => !a.startsWith("--"));
  const wanted = only.length ? ASSETS.filter((a) => only.includes(a.name)) : ASSETS;
  if (!wanted.length) throw new Error(`no asset named ${only.join(", ")}; known: ${ASSETS.map((a) => a.name).join(", ")}`);

  const key = await falKey();
  for (const asset of wanted) {
    const dest = path.join(asset.dir ?? outDir, asset.file);
    if (!force && (await fs.stat(dest).catch(() => null))) {
      console.log(`skip  ${asset.name} (exists; --force to redo)`);
      continue;
    }
    process.stdout.write(`gen   ${asset.name} ... `);
    const raw = await generate(asset, key);
    const { size } = await write(asset, raw);
    console.log(`${path.relative(root, dest)} ${(size / 1024).toFixed(0)} KB`);
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
