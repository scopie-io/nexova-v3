export function collapseWhitespace(s: string): string {
  return s.replace(/[ \t\f\v]+/g, " ").replace(/\s*\n\s*/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

export function truncate(s: string, max: number, suffix = "\n...[truncated]"): string {
  if (s.length <= max) return s;
  return s.slice(0, Math.max(0, max - suffix.length)) + suffix;
}

/** Rough token estimate (chars / 3.6) used only to keep prompts inside sane bounds. */
export function estimateTokens(s: string): number {
  return Math.ceil(s.length / 3.6);
}

export function clampText(s: string, maxTokens: number): string {
  const maxChars = Math.floor(maxTokens * 3.6);
  return truncate(s, maxChars);
}

const CURRENCY_SYMBOLS: Array<[RegExp, string]> = [
  [/\bRM\s?\d/i, "MYR"],
  [/\bS\$\s?\d/, "SGD"],
  [/\bRp\.?\s?\d/i, "IDR"],
  [/₱\s?\d|\bPHP\s?\d|\bPhp\s?\d/, "PHP"],
  [/฿\s?\d|\bTHB\s?\d/, "THB"],
  [/₫|\bVND\b|\d\s?đ\b/, "VND"],
  [/\bNT\$\s?\d/, "TWD"],
  [/\bR\$\s?\d/, "BRL"],
  [/\bA\$\s?\d/, "AUD"],
  [/£\s?\d/, "GBP"],
  [/€\s?\d|\d\s?€/, "EUR"],
  [/\bUS\$\s?\d|\$\s?\d/, "USD"],
];

/** Guess an ISO currency from free text price hints. Returns null when unsure. */
export function guessCurrencyFromText(text: string): string | null {
  for (const [re, code] of CURRENCY_SYMBOLS) {
    if (re.test(text)) return code;
  }
  return null;
}

/** Extract a numeric price from strings like "RM 25.90", "$12", "Rp150.000", "1,299.00". */
export function parsePrice(raw: string): number | null {
  const m = raw.replace(/\s/g, "").match(/(\d{1,3}(?:[.,]\d{3})+|\d+)(?:[.,](\d{1,2}))?/);
  if (!m) return null;
  let intPart = m[1];
  const frac = m[2];
  // "150.000" (IDR style thousands) vs "1,299" - if separators group by 3 and no frac, treat as thousands.
  intPart = intPart.replace(/[.,]/g, "");
  const n = Number(frac ? `${intPart}.${frac}` : intPart);
  return Number.isFinite(n) ? n : null;
}

export function firstSentence(s: string, max = 160): string {
  const clean = collapseWhitespace(s).replace(/\n+/g, " ");
  const m = clean.match(/^(.{20,}?[.!?])\s/);
  const out = m ? m[1] : clean;
  return out.length > max ? out.slice(0, max - 1).trimEnd() + "…" : out;
}

const BOILERPLATE_RE: RegExp[] = [
  /^\s*[\d.,kKmM]+\s+followers?,\s+[\d.,kKmM]+\s+following,\s+[\d.,kKmM]+\s+posts?/i,
  /see instagram (photos|videos)/i,
  /^\s*[\d.,kKmM]+\s+likes?,\s+[\d.,kKmM]+\s+comments?/i,
  /watch the latest video from/i,
  /^\s*(shopee|lazada)\b.*(free shipping|official|shop online|buy online)/i,
  /^\s*log in( or sign up)? to (see|view|continue)/i,
  /^\s*(facebook|instagram|tiktok)\s*$/i,
  /people on tiktok/i,
  /^\s*tiktok\s*[-|·]\s*make your day/i,
];

/** True when a description is platform chrome (follower counts, login walls) rather than merchant copy. */
export function isBoilerplateDescription(s: string | null | undefined): boolean {
  if (!s) return true;
  return BOILERPLATE_RE.some((re) => re.test(s));
}

/** Turn category paths like "Men Bottom > Men Pants > Men Shorts" or "home/decor" into a leaf label. */
export function leafCategory(s: string): string {
  const parts = s.split(/\s*(?:>|\/|»|\|)\s*/).map((p) => p.trim()).filter(Boolean);
  return titleCase((parts[parts.length - 1] ?? s).toLowerCase()).replace(/\bS\b/g, "s").replace(/'S\b/g, "'s");
}

export function titleCase(s: string): string {
  return s.replace(/[-_]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}
