/**
 * Generic provider: fetch the public HTML through a user-agent ladder, parse meta/OG/JSON-LD/
 * text/images, hunt embedded JSON for products, harvest contacts. Runs for every URL first.
 */
import { fetchPageLadder, isJsonShell } from "../http.js";
import { extractInstagram, extractShopee, extractTikTok } from "../parsers/embedded.js";
import { orgFromJsonLd, parseHtml, productsFromJsonLd } from "../parsers/html.js";
import { huntProductsInHtml } from "../parsers/hunter.js";
import { clampText, isBoilerplateDescription } from "../../util/text.js";
import { harvestContacts, mergeUnique, uaLadderFor, type Provider } from "./types.js";

export const directFetchProvider: Provider = {
  id: "direct-fetch",
  priority: 10,
  stage: "always",
  supports: () => true,
  async run(src, signals, ctx) {
    const res = await fetchPageLadder(src.url, uaLadderFor(src.platform), { timeoutMs: ctx.config.fetchTimeoutMs, signal: ctx.signal });
    signals.httpStatus = res.status;
    signals.embedded.fetchLadder = res.attempts.map((a) => `${a.ua}:${a.status}${a.blocked ? ":blocked" : a.thin ? ":thin" : ""}`);
    if (!res.ok || !res.body) {
      signals.errors.push(`direct-fetch: ${res.error ?? "empty response"} (tried ${res.attempts.map((a) => a.ua).join(", ")})`);
      if (res.blocked) signals.status = "blocked";
      else signals.status = "failed";
      return;
    }
    if (res.blocked) {
      signals.errors.push(`direct-fetch: page looks gated (login/captcha) via ${res.ua}`);
      signals.status = "blocked";
    }
    if (isJsonShell(res.body)) {
      signals.errors.push(`direct-fetch: anti-bot JSON shell instead of a page (via ${res.ua})`);
      signals.status = "blocked";
      return;
    }
    if (!/html|xml/i.test(res.contentType) && !res.body.trim().startsWith("<")) {
      signals.errors.push(`direct-fetch: unexpected content-type ${res.contentType}`);
      return;
    }
    const meta = parseHtml(res.body, res.finalUrl);
    signals.title = signals.title ?? meta.title;
    // Keep the raw meta in openGraph for Claude, but do not promote platform chrome to the description.
    signals.description = signals.description ?? (isBoilerplateDescription(meta.description) ? null : meta.description);
    signals.siteName = signals.siteName ?? meta.siteName;
    signals.canonicalUrl = meta.canonical ?? signals.canonicalUrl;
    signals.openGraph = { ...meta.og, ...signals.openGraph };
    signals.jsonLd.push(...meta.jsonLd);
    if (meta.lang) signals.embedded.lang = meta.lang;
    mergeUnique(signals.images, meta.images);
    mergeUnique(signals.links, meta.links, 300);
    if (meta.text && meta.text.length > signals.text.length) signals.text = clampText(meta.text, 6000);

    const ldProducts = productsFromJsonLd(meta.jsonLd).map((p) => ({ ...p, evidence: res.finalUrl, sourcePlatform: src.platform }));
    if (ldProducts.length) signals.products.push(...ldProducts);
    const org = orgFromJsonLd(meta.jsonLd);
    if (org) signals.embedded.organization = org;

    let embedded = null;
    if (src.platform === "tiktok" || src.platform === "tiktok_shop") embedded = extractTikTok(res.body);
    else if (src.platform === "instagram") embedded = extractInstagram(res.body);
    else if (src.platform === "shopee") embedded = extractShopee(res.body);
    if (embedded) {
      if (embedded.profile && !signals.profile) signals.profile = embedded.profile;
      if (embedded.products.length) signals.products.push(...embedded.products);
      mergeUnique(signals.images, embedded.images);
      Object.assign(signals.embedded, embedded.extra);
    }

    // Generic embedded-JSON hunt (Next/Nuxt state, TikTok Shop, Lazada, Shopee SEO payloads...)
    try {
      const hunted = huntProductsInHtml(res.body, { platform: src.platform, baseUrl: res.finalUrl, via: "embedded-json", maxProducts: 120 }).map((p) => ({ ...p, evidence: res.finalUrl, sourcePlatform: src.platform }));
      if (hunted.length) {
        signals.products.push(...hunted);
        signals.embedded.huntedProducts = hunted.length;
        mergeUnique(signals.images, hunted.flatMap((p) => p.images ?? []).slice(0, 40));
      }
    } catch (err) {
      signals.errors.push(`hunter: ${err instanceof Error ? err.message : String(err)}`);
    }

    harvestContacts(signals);
    if (signals.status !== "blocked") signals.status = signals.title || signals.text || signals.products.length ? "ok" : "partial";
    if (signals.status === "blocked" && (signals.products.length || signals.profile)) signals.status = "partial";
  },
};
