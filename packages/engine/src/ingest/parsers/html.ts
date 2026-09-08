/**
 * HTML parsers: meta/OpenGraph, JSON-LD, readable text, images and links.
 */
import * as cheerio from "cheerio";
import type { RawProduct } from "../../schema/signals.js";
import { collapseWhitespace } from "../../util/text.js";
import { looksLikeImageUrl, resolveUrl } from "../../util/url.js";

export interface MetaExtract {
  title: string | null;
  description: string | null;
  siteName: string | null;
  canonical: string | null;
  og: Record<string, string>;
  images: string[];
  links: string[];
  text: string;
  jsonLd: unknown[];
  lang: string | null;
}

export function parseHtml(html: string, baseUrl: string): MetaExtract {
  const $ = cheerio.load(html);
  const og: Record<string, string> = {};
  $("meta").each((_, el) => {
    const prop = ($(el).attr("property") || $(el).attr("name") || "").toLowerCase();
    const content = $(el).attr("content");
    if (!prop || !content) return;
    if (/^(og:|twitter:|product:|article:|al:|fb:|description|title|keywords|author)/.test(prop)) {
      if (!(prop in og)) og[prop] = content.trim();
    }
  });

  const title = og["og:title"] || $("title").first().text().trim() || og["twitter:title"] || null;
  const description = og["og:description"] || og["description"] || og["twitter:description"] || null;
  const siteName = og["og:site_name"] || null;
  const canonical = $('link[rel="canonical"]').attr("href") ? resolveUrl(baseUrl, $('link[rel="canonical"]').attr("href")!) : null;
  const lang = $("html").attr("lang")?.trim() || null;

  const images = new Set<string>();
  for (const key of ["og:image", "og:image:secure_url", "twitter:image", "twitter:image:src"]) {
    if (og[key]) {
      const abs = resolveUrl(baseUrl, og[key]);
      if (abs) images.add(abs);
    }
  }
  $("img").each((_, el) => {
    const src = $(el).attr("src") || $(el).attr("data-src") || $(el).attr("data-lazy-src") || "";
    const srcset = $(el).attr("srcset") || $(el).attr("data-srcset") || "";
    const candidates = [src, ...srcset.split(",").map((s) => s.trim().split(/\s+/)[0])].filter(Boolean);
    for (const c of candidates) {
      if (c.startsWith("data:")) continue;
      const abs = resolveUrl(baseUrl, c);
      if (abs && looksLikeImageUrl(abs)) images.add(abs);
    }
  });

  const links = new Set<string>();
  $("a[href]").each((_, el) => {
    const abs = resolveUrl(baseUrl, $(el).attr("href")!);
    if (abs && /^https?:/.test(abs)) links.add(abs);
  });

  const jsonLd: unknown[] = [];
  $('script[type="application/ld+json"]').each((_, el) => {
    const raw = $(el).contents().text();
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) jsonLd.push(...parsed);
      else if (parsed && typeof parsed === "object" && Array.isArray((parsed as { "@graph"?: unknown[] })["@graph"])) jsonLd.push(...((parsed as { "@graph": unknown[] })["@graph"]));
      else jsonLd.push(parsed);
    } catch {
      /* ignore malformed */
    }
  });

  $("script, style, noscript, svg, iframe, template").remove();
  const text = collapseWhitespace($("body").text() || "");

  return { title, description, siteName, canonical, og, images: [...images].slice(0, 80), links: [...links].slice(0, 300), text, jsonLd, lang };
}

type LdNode = Record<string, unknown>;

function asArray<T>(v: T | T[] | undefined | null): T[] {
  if (v == null) return [];
  return Array.isArray(v) ? v : [v];
}

function typeOf(node: LdNode): string[] {
  return asArray(node["@type"] as string | string[]).map((t) => String(t).toLowerCase());
}

function str(v: unknown): string | null {
  if (v == null) return null;
  if (typeof v === "string") return v.trim() || null;
  if (typeof v === "number") return String(v);
  if (typeof v === "object" && v && "name" in (v as LdNode)) return str((v as LdNode).name);
  return null;
}

function num(v: unknown): number | null {
  if (v == null) return null;
  const n = typeof v === "number" ? v : Number(String(v).replace(/[^0-9.]/g, ""));
  return Number.isFinite(n) ? n : null;
}

function imagesOf(v: unknown): string[] {
  return asArray(v as unknown)
    .map((i) => (typeof i === "string" ? i : (i as LdNode)?.url ?? (i as LdNode)?.contentUrl))
    .filter((s): s is string => typeof s === "string" && /^https?:/.test(s));
}

/** Flatten JSON-LD into RawProducts (Product, ItemList of Products, offers). */
export function productsFromJsonLd(nodes: unknown[], via = "jsonld"): RawProduct[] {
  const out: RawProduct[] = [];
  const visit = (node: unknown) => {
    if (!node || typeof node !== "object") return;
    const n = node as LdNode;
    const types = typeOf(n);
    if (types.includes("product") || types.includes("productgroup")) {
      const offers = asArray(n.offers as LdNode | LdNode[]);
      const first = offers[0] ?? {};
      const price = num(first.price ?? first.lowPrice ?? (first.priceSpecification as LdNode | undefined)?.price);
      const currency = str(first.priceCurrency ?? (first.priceSpecification as LdNode | undefined)?.priceCurrency);
      const availability = str(first.availability)?.toLowerCase() ?? null;
      const agg = n.aggregateRating as LdNode | undefined;
      out.push({
        title: str(n.name) ?? "Untitled product",
        description: str(n.description),
        price,
        currency,
        url: str(n.url) ?? str(first.url),
        images: imagesOf(n.image),
        externalId: str(n.sku) ?? str(n.productID) ?? str(n["@id"]),
        rating: agg ? num(agg.ratingValue) : null,
        ratingCount: agg ? num(agg.reviewCount ?? agg.ratingCount) : null,
        stock: availability ? (availability.includes("instock") ? 1 : availability.includes("outofstock") ? 0 : null) : null,
        via,
      });
    }
    if (types.includes("itemlist")) {
      for (const el of asArray(n.itemListElement as unknown[])) {
        const item = (el as LdNode)?.item ?? el;
        visit(item);
      }
    }
    for (const key of ["hasVariant", "mainEntity", "@graph"]) {
      if (n[key]) asArray(n[key] as unknown[]).forEach(visit);
    }
  };
  nodes.forEach(visit);
  return out;
}

export interface OrgFromLd {
  name: string | null;
  description: string | null;
  logo: string | null;
  url: string | null;
  sameAs: string[];
  email: string | null;
  phone: string | null;
  address: string | null;
}

export function orgFromJsonLd(nodes: unknown[]): OrgFromLd | null {
  for (const node of nodes) {
    if (!node || typeof node !== "object") continue;
    const n = node as LdNode;
    const types = typeOf(n);
    if (types.some((t) => ["organization", "store", "localbusiness", "onlinestore", "brand", "person", "website", "webpage"].includes(t))) {
      const addr = n.address as LdNode | string | undefined;
      const address = typeof addr === "string" ? addr : addr ? [addr.streetAddress, addr.addressLocality, addr.addressRegion, addr.postalCode, addr.addressCountry].map(str).filter(Boolean).join(", ") || null : null;
      const logo = imagesOf(n.logo)[0] ?? null;
      if (!str(n.name) && !logo && !str(n.description)) continue;
      return {
        name: str(n.name),
        description: str(n.description),
        logo,
        url: str(n.url),
        sameAs: asArray(n.sameAs as string[]).filter((s) => typeof s === "string"),
        email: str(n.email),
        phone: str(n.telephone),
        address,
      };
    }
  }
  return null;
}
