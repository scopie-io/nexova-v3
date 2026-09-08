/**
 * Wayback Machine fallback: when a page is blocked, an archived snapshot often still carries the
 * OG tags, JSON-LD and embedded product JSON. Products are tagged as archived so they get lower
 * precedence and a warning if nothing fresher confirms them.
 */
import { fetchJson, fetchPage } from "../http.js";
import { parseHtml, productsFromJsonLd } from "../parsers/html.js";
import { huntProductsInHtml } from "../parsers/hunter.js";
import { clampText } from "../../util/text.js";
import { harvestContacts, isThinSource, mergeUnique, type Provider } from "./types.js";

export const waybackProvider: Provider = {
  id: "wayback",
  priority: 60,
  stage: "fallback",
  supports: (src, ctx) => ctx.config.wayback && src.kind !== "post",
  async run(src, signals, ctx) {
    if (!isThinSource(signals) || signals.status === "ok") return;
    const avail = await fetchJson<{ archived_snapshots?: { closest?: { url?: string; timestamp?: string; available?: boolean } } }>(`https://archive.org/wayback/available?url=${encodeURIComponent(src.url)}`, { timeoutMs: ctx.config.fetchTimeoutMs, signal: ctx.signal, retries: 0 });
    const closest = avail.data?.archived_snapshots?.closest;
    if (!avail.ok || !closest?.available || !closest.url) {
      signals.errors.push("wayback: no snapshot");
      return;
    }
    const snapshotUrl = closest.url.replace(/^http:/, "https:").replace(/\/web\/(\d+)\//, "/web/$1id_/");
    const res = await fetchPage(snapshotUrl, { timeoutMs: Math.max(ctx.config.fetchTimeoutMs, 30_000), signal: ctx.signal, retries: 0 });
    if (!res.ok || !res.body) {
      signals.errors.push(`wayback: ${res.error ?? "fetch failed"}`);
      return;
    }
    const stamp = closest.timestamp ?? "";
    const meta = parseHtml(res.body, src.url);
    signals.title = signals.title ?? meta.title;
    signals.description = signals.description ?? meta.description;
    signals.jsonLd.push(...meta.jsonLd);
    mergeUnique(signals.images, meta.images.filter((u) => !/web\.archive\.org/.test(u) || true).map(unarchive), 120);
    mergeUnique(signals.links, meta.links.map(unarchive), 300);
    if (meta.text.length > signals.text.length) signals.text = clampText(meta.text, 6000);
    const products = [...productsFromJsonLd(meta.jsonLd, "wayback-jsonld"), ...huntProductsInHtml(res.body, { platform: src.platform, baseUrl: src.url, via: "wayback-json", maxProducts: 80 })].map((p) => ({ ...p, url: p.url ? unarchive(p.url) : null, images: (p.images ?? []).map(unarchive), evidence: snapshotUrl, sourcePlatform: src.platform, notes: [`from Wayback Machine snapshot ${stamp.slice(0, 8)}; verify prices`] }));
    signals.products.push(...products);
    signals.embedded.wayback = { snapshot: snapshotUrl, timestamp: stamp, products: products.length };
    harvestContacts(signals, meta.text);
    if (products.length || meta.title) signals.status = signals.status === "blocked" ? "partial" : signals.status;
  },
};

function unarchive(u: string): string {
  const m = u.match(/^https?:\/\/web\.archive\.org\/web\/\d+(?:id_|im_|js_|cs_)?\/(https?:\/\/.+)$/);
  return m ? m[1] : u;
}
