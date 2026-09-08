/**
 * Extractors for platform-specific JSON that public HTML pages embed.
 * Only small, relevant subsets are kept.
 */
import * as cheerio from "cheerio";
import type { RawProduct, RawProfile } from "../../schema/signals.js";

type AnyRec = Record<string, unknown>;

function get(obj: unknown, path: string[]): unknown {
  let cur: unknown = obj;
  for (const key of path) {
    if (cur && typeof cur === "object" && key in (cur as AnyRec)) cur = (cur as AnyRec)[key];
    else return undefined;
  }
  return cur;
}

function n(v: unknown): number | null {
  const x = typeof v === "number" ? v : Number(v);
  return Number.isFinite(x) ? x : null;
}
function s(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

export interface EmbeddedExtract {
  profile: RawProfile | null;
  products: RawProduct[];
  images: string[];
  extra: Record<string, unknown>;
}

/** TikTok profile pages embed __UNIVERSAL_DATA_FOR_REHYDRATION__ with user-detail. */
export function extractTikTok(html: string): EmbeddedExtract {
  const $ = cheerio.load(html);
  const result: EmbeddedExtract = { profile: null, products: [], images: [], extra: {} };
  const raw = $("#__UNIVERSAL_DATA_FOR_REHYDRATION__").contents().text() || $("#SIGI_STATE").contents().text();
  if (!raw) return result;
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return result;
  }
  const scope = (get(data, ["__DEFAULT_SCOPE__"]) as AnyRec | undefined) ?? (data as AnyRec);
  const userInfo = (get(scope, ["webapp.user-detail", "userInfo"]) as AnyRec | undefined) ?? undefined;
  if (userInfo) {
    const user = (userInfo.user ?? {}) as AnyRec;
    const stats = (userInfo.stats ?? {}) as AnyRec;
    result.profile = {
      name: s(user.nickname),
      handle: s(user.uniqueId),
      bio: s(user.signature),
      avatar: s(user.avatarLarger) ?? s(user.avatarMedium),
      followers: n(stats.followerCount),
      following: n(stats.followingCount),
      likes: n(stats.heartCount ?? stats.heart),
      verified: typeof user.verified === "boolean" ? user.verified : null,
      website: s(get(user, ["bioLink", "link"])),
      category: s(user.commerceUserInfo && (user.commerceUserInfo as AnyRec).category),
    };
    if (result.profile.avatar) result.images.push(result.profile.avatar);
    const commerce = user.commerceUserInfo as AnyRec | undefined;
    if (commerce) result.extra.commerceUser = { commerceUser: commerce.commerceUser, category: commerce.category, categoryButton: commerce.categoryButton };
  }
  // Video detail pages (product-tagged videos)
  const item = get(scope, ["webapp.video-detail", "itemInfo", "itemStruct"]) as AnyRec | undefined;
  if (item) {
    result.extra.video = { desc: s(item.desc), cover: s(get(item, ["video", "cover"])), author: s(get(item, ["author", "uniqueId"])) };
    const cover = s(get(item, ["video", "cover"]));
    if (cover) result.images.push(cover);
  }
  return result;
}

/** Instagram public HTML rarely embeds profile JSON now; scrape defensively from inline scripts. */
export function extractInstagram(html: string): EmbeddedExtract {
  const result: EmbeddedExtract = { profile: null, products: [], images: [], extra: {} };
  const bio = html.match(/"biography":"((?:[^"\\]|\\.)*)"/);
  const fullName = html.match(/"full_name":"((?:[^"\\]|\\.)*)"/);
  const username = html.match(/"username":"((?:[^"\\]|\\.)*)"/);
  const followers = html.match(/"edge_followed_by":\{"count":(\d+)\}/) ?? html.match(/"follower_count":(\d+)/);
  const pic = html.match(/"profile_pic_url_hd":"((?:[^"\\]|\\.)*)"/) ?? html.match(/"profile_pic_url":"((?:[^"\\]|\\.)*)"/);
  const external = html.match(/"external_url":"((?:[^"\\]|\\.)*)"/);
  const category = html.match(/"category_name":"((?:[^"\\]|\\.)*)"/);
  const decode = (m: RegExpMatchArray | null) => (m ? unescapeJson(m[1]) : null);
  if (bio || fullName || followers) {
    result.profile = {
      name: decode(fullName),
      handle: decode(username),
      bio: decode(bio),
      avatar: decode(pic),
      followers: followers ? Number(followers[1]) : null,
      verified: null,
      website: decode(external),
      category: decode(category),
    };
    if (result.profile.avatar) result.images.push(result.profile.avatar);
  }
  // Public post captions in og:description are handled by the generic HTML parser.
  return result;
}

/** Shopee item/shop pages are SPAs; the only embedded data is usually meta tags. Keep hook for future. */
export function extractShopee(html: string): EmbeddedExtract {
  const result: EmbeddedExtract = { profile: null, products: [], images: [], extra: {} };
  const m = html.match(/"shopid":(\d+)/);
  if (m) result.extra.shopId = Number(m[1]);
  return result;
}

/** Shopify product JSON (from /products.json) to RawProducts. */
export function productsFromShopifyJson(json: unknown, storeUrl: string): RawProduct[] {
  const products = (get(json, ["products"]) as AnyRec[] | undefined) ?? [];
  const out: RawProduct[] = [];
  for (const p of products) {
    const variants = ((p.variants as AnyRec[] | undefined) ?? []).map((v) => ({
      title: s(v.title) ?? "Default",
      price: n(v.price),
      sku: s(v.sku),
      image: null as string | null,
      stock: typeof v.available === "boolean" ? (v.available ? 1 : 0) : null,
    }));
    const images = ((p.images as AnyRec[] | undefined) ?? []).map((i) => s(i.src)).filter((x): x is string => !!x);
    const options = ((p.options as AnyRec[] | undefined) ?? []).map((o) => ({ name: s(o.name) ?? "Option", values: ((o.values as unknown[]) ?? []).map(String) }));
    const first = variants[0];
    const handle = s(p.handle);
    out.push({
      title: s(p.title) ?? "Untitled",
      description: stripTags(s(p.body_html) ?? ""),
      price: first?.price ?? null,
      currency: null,
      compareAtPrice: n(((p.variants as AnyRec[] | undefined) ?? [])[0]?.compare_at_price),
      url: handle ? `${storeUrl.replace(/\/$/, "")}/products/${handle}` : null,
      images,
      externalId: s(p.id),
      variants,
      options: options.filter((o) => !(o.values.length === 1 && o.values[0] === "Default Title")),
      tags: typeof p.tags === "string" ? (p.tags as string).split(",").map((t) => t.trim()).filter(Boolean) : Array.isArray(p.tags) ? (p.tags as string[]) : [],
      category: s(p.product_type),
      via: "shopify-products-json",
    });
  }
  return out;
}

export function stripTags(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|h\d)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function unescapeJson(s: string): string {
  try {
    return JSON.parse(`"${s}"`);
  } catch {
    return s.replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16))).replace(/\\\//g, "/").replace(/\\n/g, "\n");
  }
}
