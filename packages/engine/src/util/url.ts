const URL_RE = /\bhttps?:\/\/[^\s<>"'()]+|\bwww\.[^\s<>"'()]+|\b(?:[a-z0-9-]+\.)+(?:com|net|org|io|co|my|sg|id|ph|th|vn|tw|shop|store|app|me|tv|xyz)(?:\.[a-z]{2})?(?:\/[^\s<>"'()]*)?/gi;

/** Pull every URL-looking token out of free text, normalized with a scheme. */
export function extractUrls(text: string): string[] {
  const found = new Set<string>();
  for (const m of text.matchAll(URL_RE)) {
    const raw = m[0].replace(/[.,;:!?]+$/g, "");
    const normalized = normalizeUrl(raw);
    if (normalized) found.add(normalized);
  }
  return [...found];
}

export function normalizeUrl(raw: string): string | null {
  let s = raw.trim();
  if (!s) return null;
  if (!/^https?:\/\//i.test(s)) s = "https://" + s.replace(/^\/+/, "");
  try {
    const u = new URL(s);
    u.hash = "";
    // Strip common tracking params
    for (const key of [...u.searchParams.keys()]) {
      if (/^(utm_|fbclid|gclid|igsh|igshid|_t|_r|is_from_webapp|sender_device|web_id|checksum|sp_atk|xptdk)/i.test(key)) {
        u.searchParams.delete(key);
      }
    }
    u.hostname = u.hostname.toLowerCase();
    let out = u.toString();
    if (out.endsWith("/") && u.pathname === "/") out = out.slice(0, -1);
    return out;
  } catch {
    return null;
  }
}

export function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

export function isHttpUrl(s: string): boolean {
  return /^https?:\/\//i.test(s.trim());
}

export function resolveUrl(base: string, maybeRelative: string): string | null {
  try {
    return new URL(maybeRelative, base).toString();
  } catch {
    return null;
  }
}

const IMAGE_EXT_RE = /\.(jpe?g|png|webp|gif|avif)(\?|$)/i;
export function looksLikeImageUrl(u: string): boolean {
  return IMAGE_EXT_RE.test(u) || /\/(image|img|photo|picture|media)\//i.test(u) || /tiktokcdn|cdninstagram|fbcdn|susercontent|shopee|lazcdn/i.test(u);
}
