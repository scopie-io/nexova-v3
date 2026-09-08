/**
 * Link discovery: a merchant rarely pastes every channel. Their Instagram bio points to a
 * Linktree, the Linktree points to Shopee + TikTok Shop + WhatsApp, the Shopify footer links to
 * Facebook... We follow one hop of trusted links (from the merchant's own pages) and, when
 * channels are still missing, run a conservative web search that only accepts results whose
 * handle matches the merchant's.
 */
import type { EngineConfig } from "../config.js";
import type { DetectedUrl, SourceSignals } from "../schema/signals.js";
import type { Platform } from "../schema/store-spec.js";
import type { Logger } from "../util/log.js";
import { hostnameOf } from "../util/url.js";
import { classifyUrl } from "./detect.js";
import { fetchPage } from "./http.js";
import { parseHtml } from "./parsers/html.js";

export const BIO_LINK_HOSTS = [
  "linktr.ee",
  "beacons.ai",
  "beacons.page",
  "bio.site",
  "linkin.bio",
  "lnk.bio",
  "taplink.cc",
  "campsite.bio",
  "solo.to",
  "msha.ke",
  "carrd.co",
  "bento.me",
  "hoo.be",
  "linkpop.com",
  "wlo.link",
  "allmylinks.com",
  "snipfeed.co",
  "tap.bio",
  "shor.by",
  "linkr.bio",
  "direct.me",
  "znap.link",
  "lynk.id",
  "sociabuzz.com",
  "milkshake.app",
  "bio.link",
  "later.com",
  "stan.store",
  "komi.io",
  "linkme.bio",
  "biolinky.co",
  "heylink.me",
  "wa.link",
  "mylink.la",
  "linkby.me",
];

const SOCIAL_HOST_RE = /(tiktok\.com|instagram\.com|facebook\.com|fb\.com|fb\.me|shopee\.|shp\.ee|lazada\.|myshopify\.com|youtube\.com|t\.me|wa\.me|whatsapp\.com)/i;

export interface DiscoveredCandidate extends DetectedUrl {
  from: string;
  trust: "merchant" | "search";
}

export interface DiscoveryResult {
  candidates: DiscoveredCandidate[];
  contacts: { whatsapp: string | null };
  bioPagesFetched: string[];
  searches: string[];
}

export function isBioLinkHost(url: string): boolean {
  const host = hostnameOf(url).replace(/^www\./, "");
  return BIO_LINK_HOSTS.some((h) => host === h || host.endsWith("." + h));
}

function normHandle(s: string | null | undefined): string {
  return (s ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * Accounts belonging to the platforms themselves. Marketplace pages carry "Follow us on Facebook"
 * chrome, and without this a merchant's store would adopt Shopee's corporate Instagram as its own.
 */
const OPERATOR_HANDLE_RE = /^(shopee|lazada|tiktok|instagram|facebook|meta|whatsapp|youtube|shopify|paypal|visa|mastercard|grab|foodpanda)([_.-]?(my|sg|id|ph|th|vn|global|official|shop|app|hq|asia|indonesia|malaysia|singapore))?$/i;

export function isPlatformOperatorHandle(handle: string | null): boolean {
  if (!handle) return false;
  return OPERATOR_HANDLE_RE.test(handle.trim().replace(/^@/, ""));
}

/** Strict identity check: the candidate's handle must match one of the merchant's known handles/names. */
export function handleMatches(candidateHandle: string | null, known: Set<string>): boolean {
  const c = normHandle(candidateHandle);
  if (c.length < 3) return false;
  for (const k of known) {
    if (!k || k.length < 3) continue;
    if (c === k) return true;
    if (c.length >= 5 && k.length >= 5 && (c.includes(k) || k.includes(c))) return true;
    const ck = c.replace(/(official|shop|store|my|sg|id|hq|store|butik|kedai)$/g, "");
    const kk = k.replace(/(official|shop|store|my|sg|id|hq|store|butik|kedai)$/g, "");
    if (ck.length >= 4 && ck === kk) return true;
  }
  return false;
}

/** Collect known handles + brand tokens from what we already have. */
export function knownIdentities(sources: SourceSignals[]): Set<string> {
  const known = new Set<string>();
  for (const s of sources) {
    if (s.handle) known.add(normHandle(s.handle));
    if (s.profile?.handle) known.add(normHandle(s.profile.handle));
    if (s.profile?.name) known.add(normHandle(s.profile.name));
    const site = s.siteName || null;
    if (site) known.add(normHandle(site));
    const org = s.embedded.organization as { name?: string } | undefined;
    if (org?.name) known.add(normHandle(org.name));
    const shopifyMeta = s.embedded.shopifyMeta as { name?: string } | undefined;
    if (shopifyMeta?.name) known.add(normHandle(shopifyMeta.name));
    if (s.platform === "website" || s.platform === "shopify") {
      const host = hostnameOf(s.url).replace(/^www\./, "").split(".")[0];
      if (host && host.length >= 4) known.add(normHandle(host));
    }
  }
  known.delete("");
  return known;
}

/** Classify a batch of links found on merchant-owned pages into shop/profile candidates. */
export function candidatesFromLinks(links: string[], from: string, trust: DiscoveredCandidate["trust"], known: Set<string>, existing: Set<string>, existingPlatforms: Set<string> = new Set()): DiscoveredCandidate[] {
  const out: DiscoveredCandidate[] = [];
  const seen = new Set<string>();
  for (const link of links) {
    if (!SOCIAL_HOST_RE.test(link)) continue;
    const det = classifyUrl(link);
    if (!det || existing.has(det.url) || seen.has(det.url)) continue;
    // Only concrete shop/profile/product pages; platform roots and category pages are noise.
    if (!["profile", "shop", "product"].includes(det.kind)) continue;
    if (det.platform === "website") continue;
    if (det.kind === "profile" && !det.handle && !det.externalId) continue;
    if (det.kind === "shop" && !det.handle && !det.externalId) continue;
    if (det.handle && /^(sharer|share|explore|hashtag|tag|search|login|signup|home|policies|help|legal|about|privacy|terms|dialog|plugins|intl|accounts|reel|reels|p|stories|discover|foryou|trending|tiktokshop|mall|official|seller|buyer|user|cart|checkout|business|marketplace|groups|events|watch|gaming|pages|profile\.php)$/i.test(det.handle)) continue;
    // Never adopt a platform's own corporate account, which marketplace page chrome links to.
    if (isPlatformOperatorHandle(det.handle)) continue;
    // Once we know who the merchant is, every candidate must look like them. Missing a channel is
    // cheaper than importing an unrelated brand's profile into the merchant's store.
    const needsIdentity = trust === "search" || known.size > 0 || (existingPlatforms.has(det.platform) && det.kind === "profile");
    if (needsIdentity && !handleMatches(det.handle, known)) continue;
    seen.add(det.url);
    out.push({ ...det, from, trust });
  }
  return out;
}

export interface DiscoverOptions {
  config: EngineConfig;
  log: Logger;
  signal?: AbortSignal;
  /** Pasted URLs (already ingested). */
  existing: DetectedUrl[];
}

export async function discoverSources(sources: SourceSignals[], opts: DiscoverOptions): Promise<DiscoveryResult> {
  const result: DiscoveryResult = { candidates: [], contacts: { whatsapp: null }, bioPagesFetched: [], searches: [] };
  if (!opts.config.discovery || opts.config.maxDiscovered <= 0) return result;
  const existing = new Set(opts.existing.map((u) => u.url));
  const known = knownIdentities(sources);
  const merchantLinks: Array<{ url: string; from: string }> = [];

  // 1) Links the merchant published themselves: bio website, JSON-LD sameAs, on-page social links.
  for (const s of sources) {
    if (s.status === "failed") continue;
    const site = s.profile?.website;
    if (site) merchantLinks.push({ url: site, from: s.url });
    const org = s.embedded.organization as { sameAs?: string[] } | undefined;
    for (const same of org?.sameAs ?? []) merchantLinks.push({ url: same, from: s.url });
    for (const l of s.links) if (SOCIAL_HOST_RE.test(l) || isBioLinkHost(l)) merchantLinks.push({ url: l, from: s.url });
    const oembedAuthor = (s.oembed?.author_url as string | undefined) ?? null;
    if (oembedAuthor) merchantLinks.push({ url: oembedAuthor, from: s.url });
  }

  // 2) Expand bio-link pages (Linktree & friends) one hop.
  const bioPages = [...new Set(merchantLinks.map((l) => l.url).filter(isBioLinkHost))].slice(0, 3);
  for (const page of bioPages) {
    try {
      const res = await fetchPage(page, { timeoutMs: opts.config.fetchTimeoutMs, signal: opts.signal, ua: "desktop", retries: 0 });
      if (!res.ok) continue;
      const meta = parseHtml(res.body, res.finalUrl);
      result.bioPagesFetched.push(page);
      for (const l of meta.links) merchantLinks.push({ url: l, from: page });
      const wa = (meta.links.join("\n") + "\n" + meta.text).match(/(?:wa\.me\/|phone=)(\+?\d{7,16})/);
      if (wa && !result.contacts.whatsapp) result.contacts.whatsapp = wa[1].replace(/[^\d]/g, "");
      // Many bio pages hide links in embedded JSON (Linktree __NEXT_DATA__)
      for (const m of res.body.matchAll(/"url":"(https?:\\?\/\\?\/[^"]{8,300})"/g)) merchantLinks.push({ url: m[1].replace(/\\\//g, "/"), from: page });
    } catch (err) {
      opts.log.debug(`bio page failed ${page}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const existingPlatforms = new Set<string>(opts.existing.map((u) => u.platform));
  const fromMerchant = candidatesFromLinks(
    merchantLinks.map((l) => l.url),
    "merchant-pages",
    "merchant",
    known,
    existing,
    existingPlatforms,
  );
  // Keep provenance
  for (const c of fromMerchant) c.from = merchantLinks.find((l) => classifyUrl(l.url)?.url === c.url)?.from ?? c.from;
  result.candidates.push(...fromMerchant);

  // 3) Web search when important channels are still missing and we know who the merchant is.
  const covered = new Set<Platform>([...opts.existing.map((u) => u.platform), ...result.candidates.map((c) => c.platform)]);
  const handles = [...known].filter((k) => k.length >= 4);
  const primaryHandle = sources.map((s) => s.profile?.handle ?? s.handle).find(Boolean) ?? null;
  if (opts.config.searchDiscovery && primaryHandle && handles.length && ["shopee", "tiktok", "instagram", "lazada"].some((p) => !covered.has(p as Platform))) {
    const region = sources.map((s) => s.region).find(Boolean) ?? "my";
    const sites = ["shopee.com." + region, "shopee." + region, "tiktok.com", "instagram.com", "lazada.com." + region, "facebook.com"].filter((h) => !covered.has(platformOfHost(h)));
    const query = `"${primaryHandle}" (${sites.map((s) => `site:${s}`).join(" OR ")})`;
    result.searches.push(query);
    try {
      const res = await fetchPage(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, { timeoutMs: opts.config.fetchTimeoutMs, signal: opts.signal, ua: "desktop", retries: 0 });
      if (res.ok && !res.blocked) {
        const links: string[] = [];
        for (const m of res.body.matchAll(/uddg=([^&"']+)/g)) {
          try {
            links.push(decodeURIComponent(m[1]));
          } catch {
            /* ignore */
          }
        }
        for (const m of res.body.matchAll(/href="(https?:\/\/(?!duckduckgo)[^"]+)"/g)) links.push(m[1]);
        const existingAll = new Set([...existing, ...result.candidates.map((c) => c.url)]);
        result.candidates.push(...candidatesFromLinks(links, "web-search", "search", known, existingAll, existingPlatforms));
      }
    } catch (err) {
      opts.log.debug(`search discovery failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Rank: shops/products first, then profiles; prefer platforms not yet covered; cap.
  const seenPlatformKind = new Set<string>();
  result.candidates = result.candidates
    .sort((a, b) => rank(a, opts.existing) - rank(b, opts.existing))
    .filter((c) => {
      const key = `${c.platform}:${c.kind}:${c.handle ?? c.externalId ?? ""}`;
      if (seenPlatformKind.has(key)) return false;
      seenPlatformKind.add(key);
      return true;
    })
    .slice(0, opts.config.maxDiscovered);
  return result;
}

function platformOfHost(h: string): Platform {
  if (h.startsWith("shopee")) return "shopee";
  if (h.startsWith("tiktok")) return "tiktok";
  if (h.startsWith("instagram")) return "instagram";
  if (h.startsWith("lazada")) return "lazada";
  if (h.startsWith("facebook")) return "facebook";
  return "website";
}

function rank(c: DiscoveredCandidate, existing: DetectedUrl[]): number {
  let r = 0;
  if (c.kind === "shop") r += 0;
  else if (c.kind === "product") r += 1;
  else if (c.kind === "profile") r += 2;
  else r += 3;
  if (existing.some((e) => e.platform === c.platform)) r += 5;
  if (c.trust === "search") r += 2;
  if (c.platform === "facebook") r += 1;
  return r;
}
