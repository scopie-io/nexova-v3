/**
 * Asset localization: downloads brand/product images into the store's asset folder so the
 * live site does not depend on social CDNs (which expire links and block hotlinking).
 * Image URLs in the spec are rewritten to site-relative paths (`nexova/images/...`);
 * failed downloads keep their remote URL. Assets live at stores/<slug>/assets and are
 * copied into the template's public dir at compose time, so re-templating never re-downloads.
 */
import path from "node:path";
import type { Image, StoreSpec } from "../schema/store-spec.js";
import { downloadImage } from "../ingest/http.js";
import { exists, ensureDir, readJsonOrNull, writeJson } from "../util/fsx.js";
import { shortHash } from "../util/ids.js";
import type { Logger } from "../util/log.js";
import { mapLimit } from "../util/retry.js";

export interface LocalizeResult {
  spec: StoreSpec;
  downloaded: number;
  failed: number;
  skipped: number;
  /** Absolute local paths of the most representative images (logo, hero, first product images). */
  representative: string[];
}

interface AssetIndex {
  [sourceUrl: string]: { file: string; bytes: number };
}

export const ASSET_REL_DIR = "nexova/images";

export async function localizeAssets(spec: StoreSpec, assetsDir: string, opts: { log: Logger; signal?: AbortSignal; maxImages?: number; perProduct?: number; referer?: string | null }): Promise<LocalizeResult> {
  const imagesDir = path.join(assetsDir, "images");
  await ensureDir(imagesDir);
  const indexPath = path.join(assetsDir, "index.json");
  const index: AssetIndex = (await readJsonOrNull<AssetIndex>(indexPath)) ?? {};
  const maxImages = opts.maxImages ?? 160;
  const perProduct = opts.perProduct ?? 6;

  const next: StoreSpec = structuredClone(spec);
  const targets: Array<{ image: Image; baseName: string; priority: number }> = [];
  const push = (image: Image | null, baseName: string, priority: number) => {
    if (!image || !/^https?:\/\//i.test(image.url)) return;
    targets.push({ image, baseName, priority });
  };
  push(next.brand.logo, "brand-logo", 0);
  push(next.brand.avatar, "brand-avatar", 0);
  push(next.brand.heroImage, "brand-hero", 0);
  next.catalog.products.forEach((p, pi) => {
    p.images.slice(0, perProduct).forEach((img, i) => push(img, `${p.slug}-${i + 1}`, 1 + pi));
    p.variants.forEach((v, vi) => push(v.image, `${p.slug}-var${vi + 1}`, 1000 + pi));
  });
  next.catalog.categories.forEach((c) => push(c.image, `cat-${c.slug}`, 500));

  const selected = targets.sort((a, b) => a.priority - b.priority).slice(0, maxImages);
  let downloaded = 0;
  let failed = 0;
  let skipped = targets.length - selected.length;
  const referer = opts.referer ?? undefined;

  await mapLimit(selected, 4, async (t) => {
    const source = t.image.sourceUrl ?? t.image.url;
    const cached = index[source];
    if (cached && (await exists(path.join(imagesDir, cached.file)))) {
      t.image.sourceUrl = source;
      t.image.url = `${ASSET_REL_DIR}/${cached.file}`;
      skipped++;
      return;
    }
    const base = `${t.baseName}-${shortHash(source, 6)}`;
    const res = await downloadImage(source, imagesDir, base, { referer, signal: opts.signal, timeoutMs: 20_000 });
    if (res.ok && res.path) {
      const file = path.basename(res.path);
      index[source] = { file, bytes: res.bytes };
      t.image.sourceUrl = source;
      t.image.url = `${ASSET_REL_DIR}/${file}`;
      downloaded++;
    } else {
      failed++;
      opts.log.debug(`asset download failed: ${res.error}`, { url: source });
    }
  });

  await writeJson(indexPath, index, false);

  const representative: string[] = [];
  const localPath = (img: Image | null) => (img && img.url.startsWith(ASSET_REL_DIR) ? path.join(assetsDir, img.url.slice("nexova/".length)) : null);
  for (const img of [next.brand.logo, next.brand.heroImage, next.brand.avatar]) {
    const p = localPath(img);
    if (p) representative.push(p);
  }
  for (const prod of next.catalog.products) {
    const p = localPath(prod.images[0] ?? null);
    if (p) representative.push(p);
    if (representative.length >= 5) break;
  }
  if (downloaded + failed > 0) opts.log.info(`assets: ${downloaded} downloaded, ${skipped} reused/skipped, ${failed} failed`);
  return { spec: next, downloaded, failed, skipped, representative: [...new Set(representative)] };
}
