/**
 * Asset localization: downloads brand/product images into Nexova's own storage so the live site
 * does not depend on social CDNs (which expire links and block hotlinking).
 *
 * Image URLs in the spec are rewritten to what the template should render: a site-relative path
 * (`nexova/images/...`, copied into the template's public dir at compose time) on disk, or the
 * public Blob URL on Vercel. Failed downloads keep their remote URL. An index per store maps
 * source URLs to stored files, so re-templating never re-downloads.
 */
import type { Image, StoreSpec } from "../schema/store-spec.js";
import type { Storage } from "../storage/types.js";
import { fetchImage } from "../ingest/http.js";
import { shortHash } from "../util/ids.js";
import type { Logger } from "../util/log.js";
import { mapLimit } from "../util/retry.js";

export interface LocalizeResult {
  spec: StoreSpec;
  downloaded: number;
  failed: number;
  skipped: number;
  /** Refs (paths or URLs) of the most representative images: logo, hero, first product photos. */
  representative: string[];
}

interface AssetIndex {
  [sourceUrl: string]: { file: string; bytes: number; ref: string; url: string };
}

export const ASSET_REL_DIR = "nexova/images";

export interface LocalizeOptions {
  storage: Storage;
  slug: string;
  log: Logger;
  signal?: AbortSignal;
  maxImages?: number;
  perProduct?: number;
  referer?: string | null;
}

export async function localizeAssets(spec: StoreSpec, opts: LocalizeOptions): Promise<LocalizeResult> {
  const { storage, slug } = opts;
  const index: AssetIndex = (await storage.get<AssetIndex>("asset-index", slug)) ?? {};
  const maxImages = opts.maxImages ?? 160;
  const perProduct = opts.perProduct ?? 6;

  const next: StoreSpec = structuredClone(spec);
  const targets: Array<{ image: Image; baseName: string; priority: number }> = [];
  const push = (image: Image | null, baseName: string, priority: number) => {
    if (!image || !/^https?:\/\//i.test(image.url)) return;
    // Already stored by us (a rebuild with Blob URLs): nothing to do.
    if (Object.values(index).some((v) => v.url === image.url)) return;
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
    if (cached?.ref && (await storage.has(cached.ref))) {
      t.image.sourceUrl = source;
      t.image.url = cached.url;
      skipped++;
      return;
    }
    const res = await fetchImage(source, { referer, signal: opts.signal, timeoutMs: 20_000 });
    if (res.ok && res.data) {
      const file = `${t.baseName}-${shortHash(source, 6)}${res.ext}`;
      try {
        const stored = await storage.putBytes(`images/${slug}/${file}`, res.data, { contentType: res.contentType ?? "application/octet-stream" });
        index[source] = { file, bytes: res.data.byteLength, ref: stored.ref, url: stored.url };
        t.image.sourceUrl = source;
        t.image.url = stored.url;
        downloaded++;
      } catch (err) {
        failed++;
        opts.log.debug(`asset store failed: ${err instanceof Error ? err.message : String(err)}`, { url: source });
      }
    } else {
      failed++;
      opts.log.debug(`asset download failed: ${res.error}`, { url: source });
    }
  });

  await storage.put("asset-index", slug, index);

  const representative: string[] = [];
  const refOf = (img: Image | null) => {
    if (!img) return null;
    const hit = Object.values(index).find((v) => v.url === img.url);
    return hit?.ref ?? null;
  };
  for (const img of [next.brand.logo, next.brand.heroImage, next.brand.avatar]) {
    const r = refOf(img);
    if (r) representative.push(r);
  }
  for (const prod of next.catalog.products) {
    const r = refOf(prod.images[0] ?? null);
    if (r) representative.push(r);
    if (representative.length >= 5) break;
  }
  if (downloaded + failed > 0) opts.log.info(`assets: ${downloaded} downloaded, ${skipped} reused/skipped, ${failed} failed`);
  return { spec: next, downloaded, failed, skipped, representative: [...new Set(representative)] };
}
