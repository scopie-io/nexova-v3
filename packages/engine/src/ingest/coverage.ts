/**
 * Coverage report: what we managed to read, what is missing, and the most effective thing the
 * merchant can do about it (attach screenshots, paste the marketplace link, add WhatsApp...).
 */
import type { AttachmentExtract, CoverageReport, CoverageSource, DetectedUrl, RawProduct, SourceSignals } from "../schema/signals.js";
import { platformLabel } from "./detect.js";

const BOT_HOSTILE = new Set(["shopee", "tiktok_shop", "lazada", "facebook", "instagram", "tiktok"]);

export function buildCoverage(sources: SourceSignals[], attachments: AttachmentExtract[], products: RawProduct[], discovered: DetectedUrl[], texts: string[]): CoverageReport {
  const srcRows: CoverageSource[] = sources.map((s) => ({
    url: s.url,
    platform: s.platform,
    kind: s.kind,
    status: s.status,
    discovered: s.discovered,
    strategies: s.providers,
    attempted: s.attempts.map((a) => `${a.provider}${a.ok ? "" : "✗"}`),
    products: s.products.length,
    images: s.images.length,
    profile: !!s.profile,
    contacts: !!(s.contacts.whatsapp || s.contacts.email || s.contacts.phone || s.profile?.phone || s.profile?.email),
    note: s.errors.slice(0, 2).join(" | "),
  }));
  const withPrice = products.filter((p) => p.price != null && p.price > 0).length;
  const withImages = products.filter((p) => p.images?.length).length;
  const profiles = sources.filter((s) => s.profile).length + attachments.filter((a) => a.shopName || a.handle).length;
  const textContact = texts.some((t) => /\+?\d[\d\s-]{8,14}\d/.test(t) || /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i.test(t));
  const contacts = sources.filter((s) => s.contacts.whatsapp || s.contacts.email || s.contacts.phone || s.profile?.phone || s.profile?.email).length + attachments.filter((a) => a.contacts.whatsapp || a.contacts.email || a.contacts.phone).length + (textContact ? 1 : 0);
  const platforms = [...new Set([...sources.map((s) => s.platform), ...attachments.map((a) => a.platformGuess).filter((p) => p !== "text" && p !== "unknown")])];

  const gaps: string[] = [];
  const recommendations: string[] = [];
  const blocked = sources.filter((s) => s.status === "blocked" || s.status === "failed");
  for (const s of blocked) {
    const label = platformLabel(s.platform);
    gaps.push(`${label} ${s.kind} could not be read (${s.status}).`);
    if (BOT_HOSTILE.has(s.platform)) {
      const has = attachments.some((a) => a.platformGuess === s.platform && a.products.length);
      if (!has) recommendations.push(`${label} blocks automated reading. Attach 2–6 screenshots of your ${label} ${s.kind === "shop" ? "shop page and product list" : s.kind === "product" ? "product page" : "profile and products"} (phone screenshots are fine) so the AI can read them directly.`);
    } else recommendations.push(`Check that ${s.url} is public and reachable, or paste another link to the same shop.`);
  }
  const quotaHit = sources.find((s) => s.errors.some((e) => /RapidAPI quota exhausted/i.test(e)));
  if (quotaHit) {
    gaps.push("The TikTok Shop API (RapidAPI) quota is used up, so TikTok Shop listings could not be fetched directly.");
    recommendations.push("Upgrade the RapidAPI plan for the TikTok Shop API (or wait for its monthly reset) and rebuild; TikTok Shop links then return the full catalog automatically.");
  }
  const thinShops = sources.filter((s) => (s.status === "partial" || s.status === "ok") && (s.kind === "shop" || s.kind === "website" || s.kind === "product") && s.products.length < 3);
  for (const s of thinShops) {
    const label = platformLabel(s.platform);
    if (attachments.some((a) => a.platformGuess === s.platform && a.products.length)) continue;
    gaps.push(`${label} ${s.kind} was reachable but its product list did not render for us (${s.products.length} products).`);
    if (BOT_HOSTILE.has(s.platform)) recommendations.push(`${label} loads products only inside the app/browser. Attach screenshots of your ${label} shop page and product list (2–6 images) so names, prices and sold counts are read directly.`);
    else recommendations.push(`Only ${s.products.length} products were readable on ${label}. Screenshots of the product list, a CSV export, or pasted "name - price" lines would complete the catalog.`);
  }
  if (products.length === 0) {
    gaps.push("No products found yet.");
    recommendations.push("Paste a product list (one per line, e.g. “Matcha Kit - RM 45”), attach screenshots of your listings, or upload a CSV export.");
  } else {
    if (withPrice / products.length < 0.6) {
      gaps.push(`${products.length - withPrice} of ${products.length} products have no price.`);
      recommendations.push("Prices are missing for many products: attach screenshots of the product list or paste “name - price” lines.");
    }
    if (withImages / products.length < 0.5) {
      gaps.push(`${products.length - withImages} products have no photo.`);
      recommendations.push("Add a link where product photos are public (your Shopify/website, Shopee or TikTok Shop) so photos can be downloaded, or upload product photos later in the editor.");
    }
  }
  if (profiles === 0) {
    gaps.push("No brand profile (name, bio, avatar) was read.");
    recommendations.push("Paste your main Instagram or TikTok profile link, or add a line with your shop name and a short description.");
  }
  if (contacts === 0) {
    gaps.push("No WhatsApp/phone/email found.");
    recommendations.push("Add your WhatsApp number (e.g. +60123456789) to the text box so the store’s checkout button works from day one.");
  }
  const attachedImages = attachments.filter((a) => a.kind === "image").length;
  const extracted = attachments.filter((a) => a.products.length || a.shopName || a.handle).length;
  const unreadImages = attachments.filter((a) => a.kind === "image" && a.via === "none").length;
  if (unreadImages > 0) {
    gaps.push(`${unreadImages} screenshot${unreadImages === 1 ? "" : "s"} could not be read.`);
    recommendations.push(attachments.some((a) => /requires Claude/.test(a.notes)) ? `${unreadImages} screenshot${unreadImages === 1 ? "" : "s"} were skipped because no ANTHROPIC_API_KEY is configured; add it and rebuild to read them.` : `${unreadImages} screenshot${unreadImages === 1 ? " was" : "s were"} unreadable (blurry, cut off, or too large); retake at normal zoom.`);
  }

  // Score: identity 25, products 35, prices 15, images 15, contacts 10
  let score = 0;
  score += profiles > 0 ? 0.25 : 0;
  score += Math.min(1, products.length / 8) * 0.35;
  score += products.length ? (withPrice / products.length) * 0.15 : 0;
  score += products.length ? (withImages / products.length) * 0.15 : 0;
  score += contacts > 0 ? 0.1 : 0;

  return {
    sources: srcRows,
    attachments: { total: attachments.length, extracted, products: attachments.reduce((n, a) => n + a.products.length, 0), images: attachedImages },
    totals: { products: products.length, withPrice, withImages, profiles, contacts, platforms },
    gaps,
    recommendations: [...new Set(recommendations)].slice(0, 6),
    score: Math.round(score * 100) / 100,
  };
}

export function coverageSummary(c: CoverageReport): string {
  const ok = c.sources.filter((s) => s.status === "ok" || s.status === "partial").length;
  const parts = [`${ok}/${c.sources.length} sources readable`, `${c.totals.products} products (${c.totals.withPrice} priced, ${c.totals.withImages} with photos)`, `${c.totals.profiles} profile${c.totals.profiles === 1 ? "" : "s"}`, c.totals.contacts ? "contact found" : "no contact", `coverage ${Math.round(c.score * 100)}%`];
  return parts.join(", ");
}
