/**
 * Polite, bounded HTTP client for public pages and assets, with a user-agent ladder:
 * many sites serve full HTML to Googlebot or to mobile browsers while blocking desktop bots.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { ensureDir } from "../util/fsx.js";
import { sleep } from "../util/retry.js";

export type UaProfile = "desktop" | "mobile" | "googlebot" | "bingbot";

export const USER_AGENTS: Record<UaProfile, string> = {
  desktop: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
  mobile: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
  googlebot: "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; Googlebot/2.1; +http://www.google.com/bot.html) Chrome/128.0.0.0 Safari/537.36",
  bingbot: "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm) Chrome/128.0.0.0 Safari/537.36",
};
export const DESKTOP_UA = USER_AGENTS.desktop;
export const MOBILE_UA = USER_AGENTS.mobile;

export interface FetchPageOptions {
  timeoutMs?: number;
  headers?: Record<string, string>;
  maxBytes?: number;
  /** Deprecated alias for ua: "mobile". */
  mobile?: boolean;
  ua?: UaProfile;
  retries?: number;
  signal?: AbortSignal;
  accept?: string;
  method?: "GET" | "POST";
  body?: string;
}

export interface FetchPageResult {
  ok: boolean;
  status: number;
  finalUrl: string;
  contentType: string;
  body: string;
  error: string | null;
  blocked: boolean;
  /** True when the page has almost no readable content (SPA shell, interstitial). */
  thin: boolean;
  ua: UaProfile;
}

const BLOCK_PATTERNS = [/captcha/i, /verify you are human/i, /access denied/i, /just a moment/i, /please enable javascript and cookies/i, /login • instagram/i, /log in to continue/i, /unusual traffic/i, /request blocked/i, /security check/i, /"redirect_to_error_page"\s*:\s*true/i, /_____tmd_____|x5secdata/i, /\/punish\?/i];

/** A document request that came back as bare JSON is an anti-bot or API shell, not a page. */
export function isJsonShell(body: string): boolean {
  const s = body.trimStart();
  return (s.startsWith("{") || s.startsWith("[")) && s.length < 20_000;
}

export function isThinHtml(body: string): boolean {
  if (!body) return true;
  if (isJsonShell(body)) return true;
  const text = body
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const hasMeta = /property=["']og:title["']|application\/ld\+json|__UNIVERSAL_DATA|__INITIAL_STATE__|__NEXT_DATA__/i.test(body);
  return text.length < 400 && !hasMeta;
}

export async function fetchPage(url: string, opts: FetchPageOptions = {}): Promise<FetchPageResult> {
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const maxBytes = opts.maxBytes ?? 3 * 1024 * 1024;
  const retries = opts.retries ?? 1;
  const ua: UaProfile = opts.ua ?? (opts.mobile ? "mobile" : "desktop");
  let lastError: string | null = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ac = new AbortController();
    const onAbort = () => ac.abort(opts.signal?.reason);
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => ac.abort(new Error("timeout")), timeoutMs);
    try {
      const res = await fetch(url, {
        method: opts.method ?? "GET",
        body: opts.body,
        redirect: "follow",
        signal: ac.signal,
        headers: {
          "user-agent": USER_AGENTS[ua],
          accept: opts.accept ?? "text/html,application/xhtml+xml,application/xml;q=0.9,application/json;q=0.8,*/*;q=0.7",
          "accept-language": "en-US,en;q=0.9,ms;q=0.8,id;q=0.7",
          "cache-control": "no-cache",
          pragma: "no-cache",
          ...(ua === "desktop" || ua === "mobile" ? { "upgrade-insecure-requests": "1", "sec-fetch-dest": "document", "sec-fetch-mode": "navigate", "sec-fetch-site": "none" } : {}),
          ...(opts.headers ?? {}),
        },
      });
      const contentType = res.headers.get("content-type") ?? "";
      const body = await readBounded(res, maxBytes);
      const blocked = res.status === 403 || res.status === 429 || res.status === 401 || (res.status < 400 && BLOCK_PATTERNS.some((re) => re.test(body.slice(0, 20_000))) && body.length < 200_000);
      const result: FetchPageResult = {
        ok: res.ok,
        status: res.status,
        finalUrl: res.url || url,
        contentType,
        body,
        error: res.ok ? null : `HTTP ${res.status}`,
        blocked,
        thin: /html/i.test(contentType) ? isThinHtml(body) : body.length < 50,
        ua,
      };
      if ((res.status === 429 || res.status >= 500) && attempt < retries) {
        lastError = result.error;
        await sleep(600 * (attempt + 1), opts.signal);
        continue;
      }
      return result;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      if (attempt < retries && !opts.signal?.aborted) {
        await sleep(400 * (attempt + 1), opts.signal);
        continue;
      }
      return { ok: false, status: 0, finalUrl: url, contentType: "", body: "", error: lastError, blocked: false, thin: true, ua };
    } finally {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
    }
  }
  return { ok: false, status: 0, finalUrl: url, contentType: "", body: "", error: lastError, blocked: false, thin: true, ua };
}

export interface LadderResult extends FetchPageResult {
  attempts: Array<{ ua: UaProfile; status: number; blocked: boolean; thin: boolean }>;
}

/**
 * Try several user agents until one returns a usable page. Order is per platform: sites that
 * serve SEO HTML to crawlers (Shopee, Lazada, TikTok) are tried with Googlebot early.
 */
export async function fetchPageLadder(url: string, ladder: UaProfile[], opts: FetchPageOptions = {}): Promise<LadderResult> {
  const attempts: LadderResult["attempts"] = [];
  let best: FetchPageResult | null = null;
  for (const ua of ladder) {
    const res = await fetchPage(url, { ...opts, ua, retries: 0 });
    attempts.push({ ua, status: res.status, blocked: res.blocked, thin: res.thin });
    if (res.ok && !res.blocked && !res.thin) return { ...res, attempts };
    if (!best || (res.ok && !best.ok) || (res.ok && !res.blocked && best.blocked) || (res.ok && res.body.length > best.body.length && !res.blocked)) best = res;
    if (opts.signal?.aborted) break;
  }
  return { ...(best ?? { ok: false, status: 0, finalUrl: url, contentType: "", body: "", error: "no response", blocked: false, thin: true, ua: ladder[0] ?? "desktop" }), attempts };
}

async function readBounded(res: Response, maxBytes: number): Promise<string> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(value);
      total += value.byteLength;
      if (total >= maxBytes) {
        try {
          await reader.cancel();
        } catch {
          /* ignore */
        }
        break;
      }
    }
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString("utf8");
}

export async function fetchJson<T = unknown>(url: string, opts: FetchPageOptions = {}): Promise<{ ok: boolean; status: number; data: T | null; error: string | null; blocked: boolean }> {
  const maxBytes = opts.maxBytes ?? 12 * 1024 * 1024;
  const res = await fetchPage(url, { ...opts, maxBytes, accept: opts.accept ?? "application/json,text/plain,*/*" });
  if (!res.ok) return { ok: false, status: res.status, data: null, error: res.error, blocked: res.blocked };
  try {
    return { ok: true, status: res.status, data: JSON.parse(res.body) as T, error: null, blocked: false };
  } catch {
    const truncated = res.body.length >= maxBytes - 1024;
    return { ok: false, status: res.status, data: null, error: truncated ? `response larger than ${Math.round(maxBytes / 1024 / 1024)}MB` : /<html|<!doctype/i.test(res.body.slice(0, 300)) ? "HTML instead of JSON (login/captcha page)" : "invalid JSON", blocked: res.blocked };
  }
}

export interface DownloadResult {
  ok: boolean;
  path: string | null;
  contentType: string | null;
  bytes: number;
  error: string | null;
}

const EXT_BY_TYPE: Record<string, string> = {
  "image/jpeg": ".jpg",
  "image/jpg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
  "image/gif": ".gif",
  "image/avif": ".avif",
  "image/svg+xml": ".svg",
};

export interface FetchImageResult {
  ok: boolean;
  data: Buffer | null;
  contentType: string | null;
  /** File extension for the content type, e.g. ".webp". */
  ext: string;
  error: string | null;
}

/** Fetch a remote image into memory (size- and type-checked). */
export async function fetchImage(url: string, opts: { timeoutMs?: number; maxBytes?: number; referer?: string; signal?: AbortSignal } = {}): Promise<FetchImageResult> {
  const timeoutMs = opts.timeoutMs ?? 20_000;
  const maxBytes = opts.maxBytes ?? 8 * 1024 * 1024;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(new Error("timeout")), timeoutMs);
  const onAbort = () => ac.abort(new Error("cancelled"));
  opts.signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const res = await fetch(url, {
      redirect: "follow",
      signal: ac.signal,
      headers: { "user-agent": DESKTOP_UA, accept: "image/avif,image/webp,image/apng,image/*,*/*;q=0.8", ...(opts.referer ? { referer: opts.referer } : {}) },
    });
    if (!res.ok) return { ok: false, data: null, contentType: null, ext: "", error: `HTTP ${res.status}` };
    const contentType = (res.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
    if (!contentType.startsWith("image/")) return { ok: false, data: null, contentType, ext: "", error: `not an image (${contentType || "unknown"})` };
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.byteLength === 0) return { ok: false, data: null, contentType, ext: "", error: "empty body" };
    if (buf.byteLength > maxBytes) return { ok: false, data: null, contentType, ext: "", error: "too large" };
    return { ok: true, data: buf, contentType, ext: EXT_BY_TYPE[contentType] ?? ".img", error: null };
  } catch (err) {
    return { ok: false, data: null, contentType: null, ext: "", error: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener("abort", onAbort);
  }
}

/** Download a remote image into destDir. Returns the final path (extension by content type). */
export async function downloadImage(url: string, destDir: string, baseName: string, opts: { timeoutMs?: number; maxBytes?: number; referer?: string; signal?: AbortSignal } = {}): Promise<DownloadResult> {
  const timeoutMs = opts.timeoutMs ?? 20_000;
  const maxBytes = opts.maxBytes ?? 8 * 1024 * 1024;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(new Error("timeout")), timeoutMs);
  try {
    const res = await fetch(url, {
      redirect: "follow",
      signal: ac.signal,
      headers: {
        "user-agent": DESKTOP_UA,
        accept: "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
        ...(opts.referer ? { referer: opts.referer } : {}),
      },
    });
    if (!res.ok) return { ok: false, path: null, contentType: null, bytes: 0, error: `HTTP ${res.status}` };
    const contentType = (res.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
    if (!contentType.startsWith("image/")) return { ok: false, path: null, contentType, bytes: 0, error: `not an image (${contentType || "unknown"})` };
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.byteLength === 0) return { ok: false, path: null, contentType, bytes: 0, error: "empty body" };
    if (buf.byteLength > maxBytes) return { ok: false, path: null, contentType, bytes: buf.byteLength, error: "too large" };
    const ext = EXT_BY_TYPE[contentType] ?? ".img";
    await ensureDir(destDir);
    const p = path.join(destDir, `${baseName}${ext}`);
    await fs.writeFile(p, buf);
    return { ok: true, path: p, contentType, bytes: buf.byteLength, error: null };
  } catch (err) {
    return { ok: false, path: null, contentType: null, bytes: 0, error: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timer);
  }
}
