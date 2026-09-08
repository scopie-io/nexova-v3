/**
 * Input detection: turns whatever the merchant pasted into classified URLs + free text.
 */
import type { Platform, SourceKind } from "../schema/store-spec.js";
import type { DetectedUrl, IngestInput } from "../schema/signals.js";
import { extractUrls, hostnameOf, normalizeUrl } from "../util/url.js";

const REGION_BY_TLD: Array<[RegExp, string]> = [
  [/\.com\.my$/, "my"],
  [/\.sg$/, "sg"],
  [/\.co\.id$/, "id"],
  [/\.ph$/, "ph"],
  [/\.co\.th$/, "th"],
  [/\.vn$/, "vn"],
  [/\.tw$/, "tw"],
  [/\.com\.br$/, "br"],
  [/\.com\.mx$/, "mx"],
  [/\.co\.uk$/, "gb"],
  [/\.com\.au$/, "au"],
  [/\.co$/, "co"],
  [/\.cl$/, "cl"],
  [/\.pl$/, "pl"],
  [/\.es$/, "es"],
  [/\.fr$/, "fr"],
];

export const CURRENCY_BY_REGION: Record<string, string> = {
  my: "MYR",
  sg: "SGD",
  id: "IDR",
  ph: "PHP",
  th: "THB",
  vn: "VND",
  tw: "TWD",
  br: "BRL",
  mx: "MXN",
  gb: "GBP",
  au: "AUD",
  co: "COP",
  cl: "CLP",
  pl: "PLN",
  es: "EUR",
  fr: "EUR",
  us: "USD",
};

export const LOCALE_BY_REGION: Record<string, string> = {
  my: "en",
  sg: "en",
  id: "id",
  ph: "en",
  th: "th",
  vn: "vi",
  tw: "zh",
  br: "pt",
  mx: "es",
  gb: "en",
  au: "en",
  us: "en",
};

export function regionFromHost(host: string): string | null {
  for (const [re, region] of REGION_BY_TLD) if (re.test(host)) return region;
  return null;
}

function seg(pathname: string): string[] {
  return pathname.split("/").filter(Boolean).map((s) => decodeURIComponent(s));
}

export function classifyUrl(input: string): DetectedUrl | null {
  const det = classifyRaw(input);
  if (!det) return null;
  return { ...det, url: canonicalUrl(det) };
}

/** Canonical URL per platform so the same profile pasted in different forms dedupes and caches identically. */
function canonicalUrl(det: DetectedUrl): string {
  const h = det.handle;
  switch (det.platform) {
    case "tiktok":
      if (det.kind === "profile" && h) return `https://www.tiktok.com/@${h}`;
      if (det.kind === "post" && h && det.externalId) return `https://www.tiktok.com/@${h}/video/${det.externalId}`;
      return det.url;
    case "tiktok_shop":
      if (det.kind === "product" && det.externalId) return `https://www.tiktok.com/view/product/${det.externalId}${det.region ? `?region=${det.region.toUpperCase()}` : ""}`;
      if (det.kind === "shop" && h && det.externalId) return `https://www.tiktok.com/shop/store/${h}/${det.externalId}`;
      return det.url;
    case "instagram":
      if (det.kind === "profile" && h) return `https://www.instagram.com/${h}/`;
      if (det.kind === "post" && det.externalId) return `https://www.instagram.com/p/${det.externalId}/`;
      return det.url;
    case "facebook":
      if (det.kind === "profile" && h && !det.externalId) return `https://www.facebook.com/${h}`;
      return det.url;
    default:
      return det.url;
  }
}

function classifyRaw(input: string): DetectedUrl | null {
  const url = normalizeUrl(input);
  if (!url) return null;
  const host = hostnameOf(url);
  const bare = host.replace(/^(www|m|web|touch|mobile)\./, "");
  const u = new URL(url);
  const parts = seg(u.pathname);
  const base: DetectedUrl = { url, platform: "website", kind: "website", handle: null, region: regionFromHost(bare), externalId: null };

  // ---- TikTok ----
  if (/(^|\.)tiktok\.com$/.test(bare) || bare === "vt.tiktok.com" || bare === "vm.tiktok.com") {
    if (bare.startsWith("shop.") || parts[0] === "shop" || parts[0] === "view") {
      // Region: ?region=MY, or the market prefix on shop.tiktok.com/<cc>/pdp/<id>
      const regionParam = u.searchParams.get("region")?.toLowerCase() ?? null;
      const pathRegion = bare.startsWith("shop.") && /^[a-z]{2}$/i.test(parts[0] ?? "") ? parts[0].toLowerCase() : null;
      const region = regionParam ?? pathRegion ?? base.region;
      const after = (key: string) => (parts.includes(key) ? parts[parts.indexOf(key) + 1] ?? null : null);
      const pid = after("product") ?? after("pdp");
      if (pid) return { ...base, region, platform: "tiktok_shop", kind: "product", externalId: pid };
      // Store pages: /shop/store/<slug>/<numeric id>
      if (parts[0] === "shop" && parts[1] === "store") {
        const storeId = parts.slice(2).find((p) => /^\d{6,}$/.test(p)) ?? null;
        const slug = parts[2] && parts[2] !== storeId ? parts[2] : null;
        return { ...base, region, platform: "tiktok_shop", kind: "shop", handle: slug, externalId: storeId };
      }
      return { ...base, region, platform: "tiktok_shop", kind: "shop" };
    }
    if (bare === "vt.tiktok.com" || bare === "vm.tiktok.com") {
      return { ...base, platform: "tiktok", kind: "post", externalId: parts[0] ?? null };
    }
    const at = parts.find((p) => p.startsWith("@"));
    if (at) {
      const handle = at.slice(1);
      const isVideo = parts.includes("video");
      const videoId = isVideo ? parts[parts.indexOf("video") + 1] ?? null : null;
      return { ...base, platform: "tiktok", kind: isVideo ? "post" : "profile", handle, externalId: videoId };
    }
    return { ...base, platform: "tiktok", kind: "website" };
  }

  // ---- Instagram ----
  if (/(^|\.)instagram\.com$/.test(bare) || bare === "instagr.am") {
    if (parts[0] === "p" || parts[0] === "reel" || parts[0] === "reels" || parts[0] === "tv") {
      return { ...base, platform: "instagram", kind: "post", externalId: parts[1] ?? null };
    }
    if (parts[0] && !["explore", "accounts", "stories", "direct"].includes(parts[0])) {
      return { ...base, platform: "instagram", kind: "profile", handle: parts[0].replace(/^@/, "") };
    }
    return { ...base, platform: "instagram", kind: "website" };
  }

  // ---- Facebook ----
  if (/(^|\.)(facebook\.com|fb\.com|fb\.me)$/.test(bare)) {
    if (parts[0] === "marketplace" && parts[1] === "item") {
      return { ...base, platform: "facebook", kind: "product", externalId: parts[2] ?? null };
    }
    if (parts[0] === "profile.php") {
      return { ...base, platform: "facebook", kind: "profile", externalId: u.searchParams.get("id") };
    }
    if (parts[0] === "people") {
      return { ...base, platform: "facebook", kind: "profile", handle: parts[1] ?? null, externalId: parts[2] ?? null };
    }
    if (parts[0] === "commerce" || parts[1] === "shop" || parts[0] === "shop") {
      return { ...base, platform: "facebook", kind: "shop", handle: parts[1] === "shop" ? parts[0] : null };
    }
    if (parts[0] && !["groups", "events", "watch", "reel", "photo", "photo.php", "login", "share"].includes(parts[0])) {
      return { ...base, platform: "facebook", kind: "profile", handle: parts[0] };
    }
    if (parts[0] === "share" || parts[0] === "reel" || parts[0] === "photo") {
      return { ...base, platform: "facebook", kind: "post", externalId: parts[parts.length - 1] ?? null };
    }
    return { ...base, platform: "facebook", kind: "website" };
  }

  // ---- Shopee ----
  if (/(^|\.)shopee\.[a-z.]+$/.test(bare) || bare === "shp.ee") {
    if (bare === "shp.ee") return { ...base, platform: "shopee", kind: "shop", externalId: parts[0] ?? null };
    const last = parts[parts.length - 1] ?? "";
    const iMatch = last.match(/-i\.(\d+)\.(\d+)$/);
    if (iMatch) return { ...base, platform: "shopee", kind: "product", externalId: `${iMatch[1]}.${iMatch[2]}` };
    if (parts[0] === "product" && parts[1] && parts[2]) {
      return { ...base, platform: "shopee", kind: "product", externalId: `${parts[1]}.${parts[2]}` };
    }
    if (parts[0] === "shop" && parts[1]) return { ...base, platform: "shopee", kind: "shop", externalId: parts[1] };
    if (parts[0] && !["search", "cart", "buyer", "mall", "m", "user", "flash_sale", "daily_discover"].includes(parts[0])) {
      return { ...base, platform: "shopee", kind: "shop", handle: parts[0] };
    }
    return { ...base, platform: "shopee", kind: "website" };
  }

  // ---- Lazada ----
  if (/(^|\.)lazada\.[a-z.]+$/.test(bare) || bare === "s.lazada.com.my" || /(^|\.)lazada\.com$/.test(bare)) {
    const last = parts[parts.length - 1] ?? "";
    const idMatch = last.match(/-i(\d+)(?:-s(\d+))?\.html$/);
    if (parts[0] === "products" || idMatch) {
      return { ...base, platform: "lazada", kind: "product", externalId: idMatch?.[1] ?? null };
    }
    if (parts[0] === "shop" && parts[1]) return { ...base, platform: "lazada", kind: "shop", handle: parts[1] };
    if (bare.startsWith("s.") || bare.endsWith(".lazada.sg") || bare.endsWith(".lazada.com.my")) {
      const sub = host.split(".")[0];
      if (sub && !["www", "s", "member", "my", "sg"].includes(sub)) return { ...base, platform: "lazada", kind: "shop", handle: sub };
    }
    return { ...base, platform: "lazada", kind: "shop" };
  }

  // ---- Shopify ----
  if (/\.myshopify\.com$/.test(bare) || parts[0] === "products" || parts[0] === "collections") {
    if (parts[0] === "products" && parts[1]) return { ...base, platform: "shopify", kind: "product", handle: parts[1] };
    return { ...base, platform: "shopify", kind: "shop" };
  }

  // ---- WhatsApp: treat as contact hint, not a source ----
  if (/(^|\.)(wa\.me|whatsapp\.com)$/.test(bare)) {
    return { ...base, platform: "website", kind: "website", externalId: parts[0] ?? null };
  }

  return base;
}

/** Split pasted input into URLs (classified) and residual text lines. */
export function detectInput(raw: string): IngestInput {
  const lines = raw.split(/\r?\n/);
  const seen = new Set<string>();
  const urls: DetectedUrl[] = [];
  const texts: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const found = extractUrls(trimmed);
    if (found.length === 0) {
      texts.push(trimmed);
      continue;
    }
    for (const f of found) {
      const det = classifyUrl(f);
      if (!det || seen.has(det.url)) continue;
      seen.add(det.url);
      urls.push(det);
    }
    // Keep residual words around the URL (e.g. "my shopee: <url>") only if substantial
    const residual = found.reduce((acc, f) => acc.replace(f, "").replace(f.replace(/^https?:\/\//, ""), ""), trimmed).trim();
    if (residual.replace(/[^a-z0-9]/gi, "").length >= 12) texts.push(residual);
  }
  return { raw, urls, texts, attachments: [] };
}

const SHORT_HOSTS = /^(vt|vm)\.tiktok\.com$/i;

/**
 * Links copied from the TikTok app are short links (vt.tiktok.com/...) that redirect to a video,
 * a profile or a TikTok Shop product page. Follow the redirect once and re-classify, so a shop
 * product shared from the app is read as a shop product rather than a video.
 */
export async function expandShortLinks(input: IngestInput, opts: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<IngestInput> {
  const urls: DetectedUrl[] = [];
  const seen = new Set<string>();
  for (const det of input.urls) {
    let next = det;
    if (SHORT_HOSTS.test(hostnameOf(det.url))) {
      const target = await resolveRedirect(det.url, opts);
      const re = target ? classifyUrl(target) : null;
      if (re) next = { ...re, url: re.url };
    }
    if (seen.has(next.url)) continue;
    seen.add(next.url);
    urls.push(next);
  }
  return { ...input, urls };
}

async function resolveRedirect(url: string, opts: { timeoutMs?: number; signal?: AbortSignal }): Promise<string | null> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(new Error("timeout")), opts.timeoutMs ?? 10_000);
  const onAbort = () => ac.abort(new Error("cancelled"));
  opts.signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const res = await fetch(url, { method: "GET", redirect: "manual", signal: ac.signal, headers: { "user-agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1" } });
    const loc = res.headers.get("location");
    if (loc && /^https?:\/\//i.test(loc)) {
      // Drop the tracking payload the app attaches; keep only what identifies the page.
      const u = new URL(loc);
      for (const key of [...u.searchParams.keys()]) if (key !== "region") u.searchParams.delete(key);
      return u.toString();
    }
    return null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener("abort", onAbort);
  }
}

export function platformLabel(p: Platform): string {
  const map: Record<Platform, string> = {
    tiktok: "TikTok",
    tiktok_shop: "TikTok Shop",
    instagram: "Instagram",
    facebook: "Facebook",
    shopee: "Shopee",
    lazada: "Lazada",
    shopify: "Shopify",
    website: "Website",
    text: "Text",
    unknown: "Unknown",
  };
  return map[p];
}

export function kindLabel(k: SourceKind): string {
  return k.charAt(0).toUpperCase() + k.slice(1);
}
