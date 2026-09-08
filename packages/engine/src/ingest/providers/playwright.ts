/**
 * Optional headless-browser provider. Enabled with NEXOVA_BROWSER=1 and requires the
 * `playwright` package (npm i playwright && npx playwright install chromium).
 * It renders JS-heavy pages (Shopee, TikTok Shop, Lazada, Instagram), auto-scrolls to load lazy
 * product grids, re-runs the HTML parsers + JSON hunter on the rendered DOM, and captures a
 * full-page screenshot that is fed to Claude vision like a merchant-provided screenshot.
 */
import path from "node:path";
import { promises as fs } from "node:fs";
import { parseHtml, productsFromJsonLd } from "../parsers/html.js";
import { extractInstagram, extractShopee, extractTikTok } from "../parsers/embedded.js";
import { huntProductsInHtml } from "../parsers/hunter.js";
import { clampText } from "../../util/text.js";
import { harvestContacts, isThinSource, mergeUnique, type Provider } from "./types.js";

interface PwPage {
  goto(url: string, opts: { waitUntil: string; timeout: number }): Promise<unknown>;
  waitForTimeout(ms: number): Promise<void>;
  content(): Promise<string>;
  url(): string;
  evaluate<T>(fn: string): Promise<T>;
  screenshot(opts: { path: string; fullPage: boolean; type: "png" | "jpeg" }): Promise<unknown>;
  title(): Promise<string>;
}
interface PwContext {
  newPage(): Promise<PwPage>;
  addInitScript(script: string): Promise<void>;
}
interface PwBrowser {
  newContext(opts: { viewport: { width: number; height: number }; locale: string; userAgent?: string; deviceScaleFactor?: number }): Promise<PwContext>;
  close(): Promise<void>;
}
interface PwModule {
  chromium: { launch(opts: { headless: boolean; args?: string[] }): Promise<PwBrowser> };
}

let playwrightModule: PwModule | null | undefined;

async function loadPlaywright(): Promise<PwModule | null> {
  if (playwrightModule !== undefined) return playwrightModule;
  try {
    const modName = "playwright";
    playwrightModule = (await import(modName)) as PwModule;
  } catch {
    playwrightModule = null;
  }
  return playwrightModule;
}

const STEALTH_INIT = `
  Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
  Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3] });
  window.chrome = window.chrome || { runtime: {} };
`;

/**
 * Marketplaces gate the first view behind a language picker, a cookie banner or a login modal.
 * Clicking through them is the difference between capturing a shop and capturing an overlay.
 */
const DISMISS = `(() => {
  const ACCEPT = [/^\\s*english\\s*$/i, /^\\s*(ok|okay)\\s*$/i, /^\\s*got it\\s*$/i, /^\\s*accept(\\s+all)?\\s*$/i, /^\\s*allow all\\s*$/i, /^\\s*i agree\\s*$/i, /^\\s*agree\\s*$/i, /^\\s*continue\\s*$/i, /^\\s*terima\\s*$/i, /^\\s*setuju\\s*$/i, /^\\s*saya setuju\\s*$/i, /^\\s*đồng ý\\s*$/i, /^\\s*ตกลง\\s*$/i];
  const clicked = [];
  const visible = (n) => { const r = n.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const nodes = Array.from(document.querySelectorAll('button, [role="button"], a, .shopee-button-solid, .stardust-button, .shopee-popup__close-btn'));
  for (const re of ACCEPT) {
    const el = nodes.find((n) => { const t = (n.innerText || n.textContent || '').trim(); return t.length > 0 && t.length < 30 && re.test(t) && visible(n); });
    if (el) { try { el.click(); clicked.push(t2(el)); } catch (e) {} break; }
  }
  function t2(el) { return (el.innerText || el.textContent || '').trim().slice(0, 24); }
  for (const sel of ['.shopee-popup__close-btn', '[aria-label="Close" i]', '[aria-label="close" i]', 'button.close', '.modal-close', '.next-dialog-close']) {
    const el = document.querySelector(sel);
    if (el && visible(el)) { try { el.click(); clicked.push('close:' + sel); } catch (e) {} }
  }
  return clicked;
})()`;

/** Heuristic: did we end up on an overlay/interstitial rather than the merchant's page? */
const PAGE_STATE = `(() => {
  const text = (document.body ? document.body.innerText : '') || '';
  return { len: text.length, head: text.slice(0, 400), title: document.title || '' };
})()`;

const AUTOSCROLL = `(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let last = 0;
  for (let i = 0; i < 12; i++) {
    window.scrollBy(0, Math.max(600, window.innerHeight));
    await sleep(450);
    const h = document.body.scrollHeight;
    if (h === last && i > 3) break;
    last = h;
  }
  window.scrollTo(0, 0);
  return document.body.scrollHeight;
})()`;

const INTERSTITIAL_RE = /select (your )?(language|country|region)|pilih bahasa|choose your language|ganti bahasa|verify you are human|just a moment|captcha|log in to (continue|see)|create an account/i;

/** Reject overlays, language pickers and near-empty renders before they cost a vision call. */
export function captureWorthIt(state: { len: number; head: string; title: string }): { ok: boolean; reason: string } {
  if (state.len < 400) return { ok: false, reason: `page rendered only ${state.len} chars of text` };
  if (INTERSTITIAL_RE.test(state.head)) return { ok: false, reason: "page is a language/consent/login interstitial" };
  return { ok: true, reason: "" };
}

export const playwrightProvider: Provider = {
  id: "playwright",
  priority: 70,
  stage: "fallback",
  supports: (src, ctx) => ctx.config.browser && ["shopee", "tiktok_shop", "tiktok", "instagram", "lazada", "facebook", "website", "shopify"].includes(src.platform),
  async run(src, signals, ctx) {
    if (!isThinSource(signals)) return;
    const pw = await loadPlaywright();
    if (!pw) {
      signals.errors.push("playwright: package not installed (npm i playwright && npx playwright install chromium)");
      return;
    }
    let browser: PwBrowser | null = null;
    try {
      browser = await pw.chromium.launch({ headless: true, args: ["--disable-blink-features=AutomationControlled"] });
      const context = await browser.newContext({ viewport: { width: 1366, height: 900 }, locale: "en-US", deviceScaleFactor: 1 });
      await context.addInitScript(STEALTH_INIT);
      const page = await context.newPage();
      await page.goto(src.url, { waitUntil: "domcontentloaded", timeout: Math.max(ctx.config.fetchTimeoutMs, 30_000) });
      await page.waitForTimeout(2500);

      // Clear language pickers / cookie banners / modals, twice (dismissing one often reveals the next).
      const dismissed: string[] = [];
      for (let round = 0; round < 2; round++) {
        try {
          const clicked = await page.evaluate<string[]>(DISMISS);
          if (Array.isArray(clicked) && clicked.length) {
            dismissed.push(...clicked);
            await page.waitForTimeout(1500);
          } else break;
        } catch {
          break;
        }
      }
      if (dismissed.length) signals.embedded.playwrightDismissed = dismissed;

      try {
        await page.evaluate(AUTOSCROLL);
      } catch {
        /* ignore scroll errors */
      }
      await page.waitForTimeout(1200);
      const html = await page.content();
      const finalUrl = page.url();
      const meta = parseHtml(html, finalUrl);
      signals.title = signals.title ?? meta.title ?? (await page.title());
      signals.description = signals.description ?? meta.description;
      signals.openGraph = { ...meta.og, ...signals.openGraph };
      signals.jsonLd.push(...meta.jsonLd);
      signals.products.push(...productsFromJsonLd(meta.jsonLd, "playwright-jsonld").map((p) => ({ ...p, evidence: finalUrl, sourcePlatform: src.platform })));
      signals.products.push(...huntProductsInHtml(html, { platform: src.platform, baseUrl: finalUrl, via: "playwright-json", maxProducts: 120 }).map((p) => ({ ...p, evidence: finalUrl, sourcePlatform: src.platform })));
      mergeUnique(signals.images, meta.images, 160);
      mergeUnique(signals.links, meta.links, 300);
      if (meta.text.length > signals.text.length) signals.text = clampText(meta.text, 8000);
      const embedded = src.platform.startsWith("tiktok") ? extractTikTok(html) : src.platform === "instagram" ? extractInstagram(html) : src.platform === "shopee" ? extractShopee(html) : null;
      if (embedded) {
        if (embedded.profile && !signals.profile) signals.profile = embedded.profile;
        signals.products.push(...embedded.products);
        mergeUnique(signals.images, embedded.images);
        Object.assign(signals.embedded, embedded.extra);
      }
      harvestContacts(signals, meta.text);

      // Only spend a vision call on a page that actually rendered the merchant's content.
      let state = { len: meta.text.length, head: meta.text.slice(0, 400), title: signals.title ?? "" };
      try {
        state = await page.evaluate<typeof state>(PAGE_STATE);
      } catch {
        /* keep parsed values */
      }
      const capture = captureWorthIt(state);
      if (ctx.captureDir && capture.ok) {
        await fs.mkdir(ctx.captureDir, { recursive: true });
        const shot = path.join(ctx.captureDir, `${signals.id}-browser.png`);
        await page.screenshot({ path: shot, fullPage: true, type: "png" });
        signals.screenshots.push(shot);
      } else if (!capture.ok) {
        signals.errors.push(`playwright: ${capture.reason}; screenshot not kept`);
      }
      const gated = /captcha|verify you are human|log in to continue/i.test(meta.text.slice(0, 1500)) && signals.products.length === 0;
      signals.status = gated ? "blocked" : signals.products.length || signals.title || signals.text ? "ok" : "partial";
      signals.embedded.playwright = { finalUrl, products: signals.products.length, screenshot: signals.screenshots.length > 0, dismissed: dismissed.length, capture: capture.ok ? "kept" : capture.reason };
    } catch (err) {
      signals.errors.push(`playwright: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      try {
        await browser?.close();
      } catch {
        /* ignore */
      }
    }
  },
};
