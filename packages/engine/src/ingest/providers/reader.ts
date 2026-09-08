/**
 * Reader providers: rendered-page-as-a-service fallbacks for JS-heavy or bot-blocked pages.
 *   - Jina Reader (https://r.jina.ai/<url>): free tier without a key, renders JS, returns markdown.
 *   - Firecrawl (/v1/scrape): markdown + links + screenshot, needs FIRECRAWL_API_KEY.
 *   - Generic proxy template (ScrapingBee, ScraperAPI, Zyte...): NEXOVA_PROXY_URL with {url}.
 * They only run for sources that are still thin after direct fetch + platform APIs.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import type { RawProduct } from "../../schema/signals.js";
import { clampText, guessCurrencyFromText, parsePrice } from "../../util/text.js";
import { fetchPage } from "../http.js";
import { parseHtml, productsFromJsonLd } from "../parsers/html.js";
import { huntProductsInHtml } from "../parsers/hunter.js";
import { harvestContacts, isThinSource, mergeUnique, type Provider, type ProviderContext } from "./types.js";

const JS_HEAVY = new Set(["shopee", "lazada", "tiktok_shop", "tiktok", "instagram", "facebook"]);

function wantsReader(platform: string, kind: string, thin: boolean): boolean {
  if (!thin) return false;
  return JS_HEAVY.has(platform) || kind === "shop" || kind === "product" || kind === "website";
}

const PRICE_LINE = /(RM|MYR|S\$|SGD|Rp\.?|IDR|₱|PHP|฿|THB|₫|VND|NT\$|US\$|\$|€|£|A\$|R\$|₹|¥)\s?([\d][\d.,]*)/i;

/** Pull product candidates out of rendered markdown: a price line becomes a product with the nearest preceding title. */
export function productsFromMarkdown(md: string, via: string, evidence: string, platform: string | null): RawProduct[] {
  const lines = md.split(/\r?\n/).map((l) => l.trim());
  const out: RawProduct[] = [];
  const seen = new Set<string>();
  let lastImage: string | null = null;
  let lastLink: string | null = null;
  const titleBuffer: string[] = [];
  for (const line of lines) {
    if (!line) continue;
    const img = line.match(/!\[[^\]]*\]\((https?:[^)\s]+)\)/);
    if (img) lastImage = img[1];
    const link = line.match(/\[([^\]]{3,160})\]\((https?:[^)\s]+)\)/);
    if (link) lastLink = link[2];
    const cleaned = line
      .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
      .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/[#*_>`|]+/g, " ")
      .replace(/\s{2,}/g, " ")
      .trim();
    if (!cleaned) continue;
    const m = cleaned.match(PRICE_LINE);
    if (m) {
      const priceText = m[0];
      const price = parsePrice(m[2]);
      const before = cleaned.slice(0, m.index).replace(/[-–:|]+\s*$/, "").trim();
      const title = before.length >= 3 && before.length <= 160 ? before : [...titleBuffer].reverse().find((t) => t.length >= 3 && t.length <= 160 && !PRICE_LINE.test(t) && !/^(sold|rating|shipping|free|voucher|add to cart|buy now|\d+ sold)/i.test(t)) ?? null;
      if (title && price != null && price > 0) {
        const key = title.toLowerCase();
        if (!seen.has(key)) {
          seen.add(key);
          const soldMatch = cleaned.match(/([\d.,]+\s*[kK]?)\s*(sold|terjual|đã bán|ขายแล้ว)/i);
          out.push({
            title: title.replace(/\s+/g, " "),
            priceText,
            price,
            currency: guessCurrencyFromText(priceText),
            images: lastImage ? [lastImage] : [],
            url: lastLink,
            soldCount: soldMatch ? Math.round(parsePrice(soldMatch[1]) ?? 0) * (/k/i.test(soldMatch[1]) ? 1000 : 1) : null,
            via,
            evidence,
            sourcePlatform: (platform as RawProduct["sourcePlatform"]) ?? null,
          });
        }
      }
      titleBuffer.length = 0;
      lastImage = null;
      lastLink = null;
    } else {
      titleBuffer.push(cleaned);
      if (titleBuffer.length > 4) titleBuffer.shift();
    }
    if (out.length >= 150) break;
  }
  return out;
}

const GATED_RE = /captcha|verify you are human|just a moment|_____tmd_____|x5secdata|\/punish\?|access denied|log in to (see|continue|view)|login • instagram|create an account or log in|this content isn't available|page not found|something went wrong/i;

/**
 * Rendered pages from bot-hostile platforms are often a login wall, a captcha, or the platform's
 * generic homepage shell (Shopee renders its front page instead of the shop). Only accept the
 * markdown when it actually mentions the merchant or shows prices.
 */
export function readerContentUsable(md: string, src: { platform: string; handle: string | null; kind: string }, knownNames: string[]): { ok: boolean; reason: string } {
  const head = md.slice(0, 4000);
  if (GATED_RE.test(head)) return { ok: false, reason: "rendered a login/captcha/error page" };
  if (!JS_HEAVY.has(src.platform)) return { ok: true, reason: "" };
  const lower = md.toLowerCase();
  const mentions = [src.handle, ...knownNames].filter((n): n is string => !!n && n.length >= 3).some((n) => lower.includes(n.toLowerCase().replace(/^@/, "")));
  const hasPrices = PRICE_LINE.test(md);
  if (!mentions && !hasPrices) return { ok: false, reason: "rendered a generic platform page without the shop's content" };
  return { ok: true, reason: "" };
}

function absorbMarkdown(signals: Parameters<Provider["run"]>[1], md: string, via: string, evidence: string, platform: string): number {
  signals.markdown = clampText(md, 12_000);
  if (!signals.text || signals.text.length < 400) signals.text = clampText(md.replace(/!\[[^\]]*\]\([^)]*\)/g, "").replace(/\[([^\]]*)\]\([^)]*\)/g, "$1"), 6000);
  const images = [...md.matchAll(/!\[[^\]]*\]\((https?:[^)\s]+)\)/g)].map((m) => m[1]);
  mergeUnique(signals.images, images, 160);
  const links = [...md.matchAll(/\]\((https?:[^)\s]+)\)/g)].map((m) => m[1]);
  mergeUnique(signals.links, links, 300);
  const products = productsFromMarkdown(md, via, evidence, platform);
  signals.products.push(...products);
  harvestContacts(signals, md);
  if (signals.status !== "ok" && (products.length || signals.text.length > 400)) signals.status = signals.status === "blocked" && !products.length ? "partial" : "ok";
  return products.length;
}

export const jinaReaderProvider: Provider = {
  id: "reader-jina",
  priority: 50,
  stage: "fallback",
  supports: (src, ctx) => (ctx.config.reader === "auto" || ctx.config.reader === "jina") && src.kind !== "post",
  async run(src, signals, ctx) {
    if (!wantsReader(src.platform, src.kind, isThinSource(signals))) return;
    const headers: Record<string, string> = { accept: "application/json", "x-return-format": "markdown", "x-with-images-summary": "true", "x-with-links-summary": "true", "x-timeout": "25" };
    if (ctx.config.jinaApiKey) headers.authorization = `Bearer ${ctx.config.jinaApiKey}`;
    const res = await fetchPage(`https://r.jina.ai/${src.url}`, { timeoutMs: Math.max(ctx.config.fetchTimeoutMs, 40_000), signal: ctx.signal, headers, accept: "application/json", retries: 0 });
    if (!res.ok) {
      signals.errors.push(`reader-jina: ${res.error ?? "failed"}`);
      return;
    }
    let md = "";
    let title: string | null = null;
    try {
      const json = JSON.parse(res.body) as { data?: { content?: string; title?: string; description?: string; images?: Record<string, string>; links?: Record<string, string> } };
      md = json.data?.content ?? "";
      title = json.data?.title ?? null;
      if (json.data?.images) mergeUnique(signals.images, Object.values(json.data.images).filter((u) => /^https?:/.test(u)), 160);
      if (json.data?.links) mergeUnique(signals.links, Object.values(json.data.links).filter((u) => /^https?:/.test(u)), 300);
      if (json.data?.description && !signals.description) signals.description = json.data.description;
    } catch {
      md = res.body;
    }
    if (!md || md.length < 80) {
      signals.errors.push("reader-jina: empty render");
      return;
    }
    const usable = readerContentUsable(md, src, [signals.profile?.name ?? null, signals.siteName ?? null].filter((x): x is string => !!x));
    if (!usable.ok) {
      signals.errors.push(`reader-jina: ${usable.reason}`);
      return;
    }
    if (title && !signals.title && !/^(shopee|lazada|tiktok|instagram|facebook)\b/i.test(title)) signals.title = title;
    const n = absorbMarkdown(signals, md, "reader-jina", src.url, src.platform);
    signals.embedded.readerJina = { chars: md.length, products: n };
  },
};

export const firecrawlProvider: Provider = {
  id: "reader-firecrawl",
  priority: 45,
  stage: "fallback",
  supports: (src, ctx) => !!ctx.config.firecrawlApiKey && (ctx.config.reader === "auto" || ctx.config.reader === "firecrawl") && src.kind !== "post",
  async run(src, signals, ctx) {
    if (!wantsReader(src.platform, src.kind, isThinSource(signals))) return;
    const res = await fetchPage("https://api.firecrawl.dev/v1/scrape", {
      method: "POST",
      body: JSON.stringify({ url: src.url, formats: ["markdown", "html", "links", "screenshot@fullPage"], onlyMainContent: false, waitFor: 3000, timeout: 40_000 }),
      headers: { authorization: `Bearer ${ctx.config.firecrawlApiKey}`, "content-type": "application/json" },
      accept: "application/json",
      timeoutMs: 60_000,
      signal: ctx.signal,
      retries: 0,
    });
    if (!res.ok) {
      signals.errors.push(`reader-firecrawl: ${res.error ?? "failed"}`);
      return;
    }
    try {
      const json = JSON.parse(res.body) as { success?: boolean; data?: { markdown?: string; html?: string; links?: string[]; screenshot?: string; metadata?: Record<string, unknown> } };
      const d = json.data ?? {};
      if (d.links) mergeUnique(signals.links, d.links.filter((u) => /^https?:/.test(u)), 300);
      if (d.html) {
        const meta = parseHtml(d.html, src.url);
        signals.title = signals.title ?? meta.title;
        signals.jsonLd.push(...meta.jsonLd);
        signals.products.push(...productsFromJsonLd(meta.jsonLd, "reader-firecrawl-jsonld").map((p) => ({ ...p, evidence: src.url })));
        signals.products.push(...huntProductsInHtml(d.html, { platform: src.platform, baseUrl: src.url, via: "reader-firecrawl-json", maxProducts: 120 }).map((p) => ({ ...p, evidence: src.url })));
        mergeUnique(signals.images, meta.images, 160);
      }
      const usable = d.markdown ? readerContentUsable(d.markdown, src, [signals.profile?.name ?? null].filter((x): x is string => !!x)) : { ok: false, reason: "no markdown" };
      if (d.markdown && usable.ok) absorbMarkdown(signals, d.markdown, "reader-firecrawl", src.url, src.platform);
      else signals.errors.push(`reader-firecrawl: ${usable.reason}`);
      // A screenshot of a gated page is useless to vision; keep it only when the content was usable.
      if (d.screenshot && ctx.captureDir && usable.ok) await saveScreenshot(d.screenshot, ctx, signals);
    } catch (err) {
      signals.errors.push(`reader-firecrawl: ${err instanceof Error ? err.message : String(err)}`);
    }
  },
};

export const proxyReaderProvider: Provider = {
  id: "reader-proxy",
  priority: 48,
  stage: "fallback",
  supports: (src, ctx) => !!ctx.config.proxyUrlTemplate && (ctx.config.reader === "auto" || ctx.config.reader === "proxy") && src.kind !== "post",
  async run(src, signals, ctx) {
    if (!wantsReader(src.platform, src.kind, isThinSource(signals))) return;
    const target = ctx.config.proxyUrlTemplate!.replace("{url}", encodeURIComponent(src.url));
    const res = await fetchPage(target, { timeoutMs: 60_000, signal: ctx.signal, retries: 0 });
    if (!res.ok || res.blocked) {
      signals.errors.push(`reader-proxy: ${res.error ?? "blocked"}`);
      return;
    }
    const meta = parseHtml(res.body, src.url);
    const usable = readerContentUsable(meta.text, src, [signals.profile?.name ?? null].filter((x): x is string => !!x));
    if (!usable.ok) {
      signals.errors.push(`reader-proxy: ${usable.reason}`);
      return;
    }
    signals.title = signals.title ?? meta.title;
    signals.description = signals.description ?? meta.description;
    signals.jsonLd.push(...meta.jsonLd);
    mergeUnique(signals.images, meta.images, 160);
    mergeUnique(signals.links, meta.links, 300);
    if (meta.text.length > signals.text.length) signals.text = clampText(meta.text, 6000);
    signals.products.push(...productsFromJsonLd(meta.jsonLd, "reader-proxy-jsonld").map((p) => ({ ...p, evidence: src.url })));
    signals.products.push(...huntProductsInHtml(res.body, { platform: src.platform, baseUrl: src.url, via: "reader-proxy-json", maxProducts: 120 }).map((p) => ({ ...p, evidence: src.url })));
    harvestContacts(signals, meta.text);
    if (signals.products.length || meta.text.length > 400) signals.status = "ok";
  },
};

async function saveScreenshot(dataOrUrl: string, ctx: ProviderContext, signals: Parameters<Provider["run"]>[1]): Promise<void> {
  try {
    let buf: Buffer;
    if (dataOrUrl.startsWith("data:")) buf = Buffer.from(dataOrUrl.split(",")[1] ?? "", "base64");
    else {
      const r = await fetch(dataOrUrl);
      if (!r.ok) return;
      buf = Buffer.from(await r.arrayBuffer());
    }
    if (buf.byteLength < 1000) return;
    await fs.mkdir(ctx.captureDir!, { recursive: true });
    const p = path.join(ctx.captureDir!, `${signals.id}-firecrawl.png`);
    await fs.writeFile(p, buf);
    signals.screenshots.push(p);
  } catch {
    /* ignore */
  }
}

export const readerProviders: Provider[] = [firecrawlProvider, proxyReaderProvider, jinaReaderProvider];
