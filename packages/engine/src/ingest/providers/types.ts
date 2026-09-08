import type { EngineConfig } from "../../config.js";
import type { DetectedUrl, SourceSignals } from "../../schema/signals.js";
import type { Logger } from "../../util/log.js";
import type { UaProfile } from "../http.js";

export interface ProviderContext {
  config: EngineConfig;
  log: Logger;
  signal?: AbortSignal;
  /** Directory where browser providers may save full-page screenshots for vision. */
  captureDir?: string;
  jobId?: string | null;
}

/**
 * A provider knows how to pull signals for some platforms. Providers mutate the shared
 * SourceSignals record (append-only: never remove what another provider found) and
 * must never throw for expected failures - push a message to `signals.errors` instead.
 */
export interface Provider {
  id: string;
  /** Lower runs first. */
  priority: number;
  /** "always" providers run for every supported source; "fallback" providers only when the source is still thin. */
  stage?: "always" | "fallback";
  supports(src: DetectedUrl, ctx: ProviderContext): boolean;
  run(src: DetectedUrl, signals: SourceSignals, ctx: ProviderContext): Promise<void>;
}

export function mergeUnique(target: string[], incoming: string[], max = 120): void {
  const seen = new Set(target);
  for (const v of incoming) {
    if (target.length >= max) break;
    if (!seen.has(v)) {
      seen.add(v);
      target.push(v);
    }
  }
}

/** True when a source still lacks the essentials and a more expensive strategy is worth trying. */
export function isThinSource(signals: SourceSignals): boolean {
  const hasProducts = signals.products.length >= 3;
  const hasIdentity = !!signals.profile || !!signals.title;
  if (signals.status === "blocked" || signals.status === "failed") return true;
  if (signals.kind === "product") return signals.products.length === 0;
  if (signals.kind === "shop" || signals.kind === "website") return !hasProducts;
  if (signals.kind === "profile") return !hasIdentity || (!signals.profile?.bio && signals.products.length === 0);
  return !hasIdentity && !hasProducts;
}

/** Platform-specific user-agent ladders: crawlers often get SEO HTML where desktop bots get 403. */
export function uaLadderFor(platform: string): UaProfile[] {
  switch (platform) {
    case "shopee":
    case "lazada":
    case "tiktok_shop":
      return ["googlebot", "desktop", "mobile"];
    case "tiktok":
      return ["desktop", "googlebot", "mobile"];
    case "instagram":
    case "facebook":
      return ["mobile", "googlebot", "desktop"];
    default:
      return ["desktop", "googlebot"];
  }
}

const WA_RE = /(?:wa\.me\/|api\.whatsapp\.com\/send\?(?:[^"'\s]*&)?phone=|whatsapp\.com\/send\?(?:[^"'\s]*&)?phone=)(\+?\d{7,16})/i;
const MAILTO_RE = /mailto:([a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,})/i;
const TEL_RE = /tel:(\+?[\d\s()-]{7,20})/i;
const EMAIL_RE = /\b[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}\b/i;
const WA_TEXT_RE = /whatsapp[^\d+]{0,25}(\+?\d[\d\s-]{7,15}\d)/i;

/** Pull contact facts from links + text into signals.contacts (never overwrite a found value). */
export function harvestContacts(signals: SourceSignals, extraText = ""): void {
  const c = signals.contacts;
  const links = signals.links.join("\n");
  if (!c.whatsapp) {
    const m = links.match(WA_RE) ?? (signals.text + "\n" + extraText).match(WA_TEXT_RE);
    if (m) c.whatsapp = m[1].replace(/[^\d]/g, "");
  }
  if (!c.email) {
    const m = links.match(MAILTO_RE) ?? (signals.text + "\n" + (signals.description ?? "") + "\n" + extraText).match(EMAIL_RE);
    if (m && !/(sentry|example|wixpress|shopify|noreply|no-reply)/i.test(m[1] ?? m[0])) c.email = (m[1] ?? m[0]).toLowerCase();
  }
  if (!c.phone) {
    const m = links.match(TEL_RE);
    if (m) c.phone = m[1].trim();
  }
  if (signals.profile) {
    if (!signals.profile.email && c.email) signals.profile.email = c.email;
    if (!signals.profile.phone && (c.phone || c.whatsapp)) signals.profile.phone = c.phone ?? c.whatsapp;
  }
}
