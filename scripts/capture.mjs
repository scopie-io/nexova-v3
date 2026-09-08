#!/usr/bin/env node
/**
 * Capture a full-page screenshot of any URL, for testing the vision path or for
 * attaching a page the engine cannot read.
 *
 *   node scripts/capture.mjs <url> <out.png> [--width 1366] [--wait 4000] [--viewport-only]
 *
 * Requires: npm i -D playwright && npx playwright install chromium
 */
import { chromium } from "playwright";

const [url, out = "capture.png", ...rest] = process.argv.slice(2);
if (!url) {
  console.error("usage: node scripts/capture.mjs <url> <out.png> [--width N] [--wait MS] [--viewport-only]");
  process.exit(1);
}
const arg = (name, fallback) => {
  const i = rest.indexOf(`--${name}`);
  return i >= 0 && rest[i + 1] ? Number(rest[i + 1]) : fallback;
};
const width = arg("width", 1366);
const wait = arg("wait", 4000);
const fullPage = !rest.includes("--viewport-only");

const DISMISS = `(() => {
  const ACCEPT = [/^\\s*english\\s*$/i, /^\\s*(ok|okay)\\s*$/i, /^\\s*got it\\s*$/i, /^\\s*accept(\\s+all)?\\s*$/i, /^\\s*allow all\\s*$/i, /^\\s*i agree\\s*$/i, /^\\s*agree\\s*$/i, /^\\s*continue\\s*$/i, /^\\s*terima\\s*$/i, /^\\s*setuju\\s*$/i];
  const clicked = [];
  const visible = (n) => { const r = n.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const nodes = Array.from(document.querySelectorAll('button, [role="button"], a, .shopee-button-solid, .stardust-button'));
  for (const re of ACCEPT) {
    const el = nodes.find((n) => { const t = (n.innerText || n.textContent || '').trim(); return t && t.length < 30 && re.test(t) && visible(n); });
    if (el) { try { el.click(); clicked.push((el.innerText || '').trim().slice(0, 24)); } catch (e) {} break; }
  }
  for (const sel of ['.shopee-popup__close-btn', '[aria-label="Close" i]', 'button.close', '.modal-close']) {
    const el = document.querySelector(sel);
    if (el && visible(el)) { try { el.click(); clicked.push('close'); } catch (e) {} }
  }
  return clicked;
})()`;

const AUTOSCROLL = `(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let last = 0;
  for (let i = 0; i < 14; i++) {
    window.scrollBy(0, Math.max(600, window.innerHeight));
    await sleep(400);
    const h = document.body.scrollHeight;
    if (h === last && i > 3) break;
    last = h;
  }
  window.scrollTo(0, 0);
  await sleep(600);
  return document.body.innerText.length;
})()`;

const browser = await chromium.launch({ headless: true, args: ["--disable-blink-features=AutomationControlled"] });
try {
  const context = await browser.newContext({ viewport: { width, height: 900 }, locale: "en-US" });
  await context.addInitScript(`Object.defineProperty(navigator, 'webdriver', { get: () => undefined });`);
  const page = await context.newPage();
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 });
  await page.waitForTimeout(wait);
  for (let i = 0; i < 2; i++) {
    const clicked = await page.evaluate(DISMISS).catch(() => []);
    if (!clicked?.length) break;
    console.log("dismissed:", clicked.join(", "));
    await page.waitForTimeout(1500);
  }
  const chars = await page.evaluate(AUTOSCROLL).catch(() => 0);
  await page.screenshot({ path: out, fullPage, type: "png" });
  console.log(`saved ${out} (${chars} chars of text, title: ${await page.title()})`);
} finally {
  await browser.close();
}
