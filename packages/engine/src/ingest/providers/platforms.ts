/**
 * Platform-specific providers. Each one tries public endpoints that often work without
 * cookies and degrades gracefully when the platform blocks the request. Readers, the browser,
 * screenshots and Claude web research fill the remaining gaps.
 */
import { fetchJson, fetchPage, fetchPageLadder } from "../http.js";
import { productsFromShopifyJson } from "../parsers/embedded.js";
import { huntProductsInHtml } from "../parsers/hunter.js";
import { parseHtml } from "../parsers/html.js";
import { harvestContacts, mergeUnique, type Provider } from "./types.js";
import type { RawProduct } from "../../schema/signals.js";

type AnyRec = Record<string, unknown>;

/** TikTok public oEmbed: works for profiles and videos without auth. */
export const tiktokOembedProvider: Provider = {
  id: "tiktok-oembed",
  priority: 20,
  stage: "always",
  supports: (src) => src.platform === "tiktok" || src.platform === "tiktok_shop",
  async run(src, signals, ctx) {
    const res = await fetchJson<AnyRec>(`https://www.tiktok.com/oembed?url=${encodeURIComponent(src.url)}`, { timeoutMs: ctx.config.fetchTimeoutMs, signal: ctx.signal });
    if (!res.ok || !res.data) {
      signals.errors.push(`tiktok-oembed: ${res.error ?? "no data"}`);
      return;
    }
    signals.oembed = res.data;
    const d = res.data;
    if (typeof d.title === "string" && !signals.description) signals.description = d.title;
    if (typeof d.author_name === "string") {
      signals.profile = signals.profile ?? { name: null, handle: null, bio: null, avatar: null, followers: null, verified: null, website: null };
      signals.profile.name = signals.profile.name ?? d.author_name;
      if (!signals.profile.handle && typeof d.author_unique_id === "string") signals.profile.handle = d.author_unique_id;
    }
    if (typeof d.thumbnail_url === "string") mergeUnique(signals.images, [d.thumbnail_url]);
    if (signals.status === "skipped" || signals.status === "failed") signals.status = "partial";
  },
};

const IG_APP_ID = "936619743392459";
const IG_MOBILE_UA = "Instagram 275.0.0.27.98 Android (33/13; 420dpi; 1080x2400; samsung; SM-G991B; o1s; exynos2100; en_US; 458229237)";

function applyInstagramUser(user: AnyRec, signals: Parameters<Provider["run"]>[1], handle: string): void {
  signals.profile = {
    name: (user.full_name as string) || signals.profile?.name || null,
    handle: (user.username as string) || handle,
    bio: (user.biography as string) || signals.profile?.bio || null,
    avatar: (user.profile_pic_url_hd as string) || (user.profile_pic_url as string) || signals.profile?.avatar || null,
    followers: ((user.edge_followed_by as AnyRec | undefined)?.count as number) ?? (user.follower_count as number) ?? signals.profile?.followers ?? null,
    following: ((user.edge_follow as AnyRec | undefined)?.count as number) ?? (user.following_count as number) ?? null,
    verified: typeof user.is_verified === "boolean" ? user.is_verified : null,
    website: (user.external_url as string) || signals.profile?.website || null,
    category: (user.category_name as string) || (user.category as string) || null,
    email: (user.business_email as string) || (user.public_email as string) || null,
    phone: (user.business_phone_number as string) || (user.contact_phone_number as string) || null,
  };
  if (signals.profile.avatar) mergeUnique(signals.images, [signals.profile.avatar]);
  const bioLinks = (user.bio_links as AnyRec[] | undefined) ?? [];
  for (const l of bioLinks) if (typeof l.url === "string") mergeUnique(signals.links, [l.url as string], 300);
  const edges = ((user.edge_owner_to_timeline_media as AnyRec | undefined)?.edges as AnyRec[] | undefined) ?? [];
  const posts: Array<{ caption: string; image: string | null; url: string | null; likes: number | null }> = [];
  for (const e of edges.slice(0, 12)) {
    const node = (e.node ?? {}) as AnyRec;
    const caption = (((node.edge_media_to_caption as AnyRec | undefined)?.edges as AnyRec[] | undefined)?.[0]?.node as AnyRec | undefined)?.text as string | undefined;
    const image = (node.display_url as string) || (node.thumbnail_src as string) || null;
    const shortcode = node.shortcode as string | undefined;
    posts.push({ caption: caption ?? "", image, url: shortcode ? `https://www.instagram.com/p/${shortcode}/` : null, likes: ((node.edge_liked_by as AnyRec | undefined)?.count as number) ?? null });
    if (image) mergeUnique(signals.images, [image]);
  }
  if (posts.length) signals.embedded.recentPosts = posts;
  signals.status = "ok";
}

/** Instagram: two public JSON endpoints (web app id, then the mobile app identity). Best-effort. */
export const instagramProfileProvider: Provider = {
  id: "instagram-profile-api",
  priority: 20,
  stage: "always",
  supports: (src) => src.platform === "instagram" && src.kind === "profile" && !!src.handle,
  async run(src, signals, ctx) {
    const handle = src.handle!;
    const common = { timeoutMs: ctx.config.fetchTimeoutMs, signal: ctx.signal, retries: 0 };
    const web = await fetchJson<AnyRec>(`https://www.instagram.com/api/v1/users/web_profile_info/?username=${encodeURIComponent(handle)}`, { ...common, headers: { "x-ig-app-id": IG_APP_ID, "x-requested-with": "XMLHttpRequest", referer: `https://www.instagram.com/${handle}/` } });
    const webUser = web.data && ((web.data.data as AnyRec | undefined)?.user as AnyRec | undefined);
    if (web.ok && webUser) return applyInstagramUser(webUser, signals, handle);
    signals.errors.push(`instagram-profile-api(web): ${web.error ?? (web.blocked ? "blocked" : "no user")}`);

    const mobile = await fetchJson<AnyRec>(`https://i.instagram.com/api/v1/users/web_profile_info/?username=${encodeURIComponent(handle)}`, { ...common, headers: { "x-ig-app-id": IG_APP_ID, "user-agent": IG_MOBILE_UA } });
    const mobileUser = mobile.data && ((mobile.data.data as AnyRec | undefined)?.user as AnyRec | undefined);
    if (mobile.ok && mobileUser) return applyInstagramUser(mobileUser, signals, handle);
    signals.errors.push(`instagram-profile-api(mobile): ${mobile.error ?? (mobile.blocked ? "blocked" : "no user")}`);
  },
};

const SHOPEE_HEADERS = { "x-api-source": "pc", "x-requested-with": "XMLHttpRequest", "af-ac-enc-dat": "", "x-shopee-language": "en" };

/** Shopee public v4 endpoints: shop detail, shop base, item detail, item listings (two endpoints). Frequently rate-limited. */
export const shopeeApiProvider: Provider = {
  id: "shopee-api",
  priority: 20,
  stage: "always",
  supports: (src) => src.platform === "shopee" && (src.kind === "shop" || src.kind === "product"),
  async run(src, signals, ctx) {
    const origin = new URL(src.url).origin;
    const common = { timeoutMs: ctx.config.fetchTimeoutMs, signal: ctx.signal, retries: 0, headers: { ...SHOPEE_HEADERS, referer: src.url } };
    let shopId: number | null = typeof signals.embedded.shopId === "number" ? (signals.embedded.shopId as number) : null;
    if (src.kind === "product" && src.externalId?.includes(".")) shopId = Number(src.externalId.split(".")[0]);
    if (src.kind === "shop" && src.externalId && /^\d+$/.test(src.externalId)) shopId = Number(src.externalId);

    if (!shopId && src.handle) {
      for (const endpoint of [`${origin}/api/v4/shop/get_shop_detail?username=${encodeURIComponent(src.handle)}`, `${origin}/api/v4/shop/get_shop_base?username=${encodeURIComponent(src.handle)}`]) {
        const res = await fetchJson<AnyRec>(endpoint, common);
        const data = res.data?.data as AnyRec | undefined;
        if (res.ok && data && (data.shopid || data.shop_id)) {
          shopId = (data.shopid as number) ?? (data.shop_id as number) ?? null;
          signals.profile = signals.profile ?? { name: null, handle: null, bio: null, avatar: null, followers: null, verified: null, website: null };
          signals.profile.name = signals.profile.name ?? ((data.name as string) || null);
          signals.profile.handle = signals.profile.handle ?? (((data.account as AnyRec | undefined)?.username as string) || src.handle);
          signals.profile.bio = signals.profile.bio ?? ((data.description as string) || null);
          signals.profile.avatar = signals.profile.avatar ?? (data.image ? `https://down-my.img.susercontent.com/file/${data.image}` : null);
          signals.profile.followers = signals.profile.followers ?? ((data.follower_count as number) ?? null);
          signals.profile.verified = typeof data.is_official_shop === "boolean" ? (data.is_official_shop as boolean) : signals.profile.verified;
          signals.profile.location = signals.profile.location ?? ((data.shop_location as string) || null);
          signals.embedded.shopStats = { rating: data.rating_star, itemCount: data.item_count, responseRate: data.response_rate };
          if (signals.profile.avatar) mergeUnique(signals.images, [signals.profile.avatar]);
          break;
        }
        signals.errors.push(`shopee-api(${endpoint.includes("base") ? "base" : "shop"}): ${res.error ?? (res.blocked ? "blocked" : "no data")}`);
      }
    }

    if (src.kind === "product" && src.externalId?.includes(".")) {
      const [sid, iid] = src.externalId.split(".");
      const res = await fetchJson<AnyRec>(`${origin}/api/v4/pdp/get_pc?shop_id=${sid}&item_id=${iid}`, common);
      const item = (res.data?.data as AnyRec | undefined)?.item as AnyRec | undefined;
      if (res.ok && item) {
        signals.products.push(shopeeItemToProduct(item, origin, src.url));
        signals.status = "ok";
      } else {
        signals.errors.push(`shopee-api(item): ${res.error ?? (res.blocked ? "blocked" : "no data")}`);
      }
    }

    if (shopId) {
      signals.embedded.shopId = shopId;
      const listings = [
        `${origin}/api/v4/search/search_items?by=pop&limit=30&match_id=${shopId}&newest=0&order=desc&page_type=shop&scenario=PAGE_OTHERS&version=2`,
        `${origin}/api/v4/recommend/recommend?bundle=shop_page_product_tab_main&limit=30&offset=0&shopid=${shopId}&sort_type=1`,
      ];
      for (const endpoint of listings) {
        const res = await fetchJson<AnyRec>(endpoint, common);
        const items = ((res.data?.items as AnyRec[] | undefined) ?? (((res.data?.data as AnyRec | undefined)?.sections as AnyRec[] | undefined)?.[0]?.data as AnyRec | undefined)?.item as AnyRec[] | undefined) ?? [];
        if (res.ok && items.length) {
          for (const it of items) signals.products.push(shopeeItemToProduct((it.item_basic ?? it) as AnyRec, origin, src.url));
          signals.status = "ok";
          break;
        }
        signals.errors.push(`shopee-api(${endpoint.includes("recommend") ? "recommend" : "items"}): ${res.error ?? (res.blocked ? "blocked" : "no items")}`);
      }
    }
  },
};

function shopeeItemToProduct(item: AnyRec, origin: string, evidence: string): RawProduct {
  const toMajor = (v: unknown) => (typeof v === "number" ? v / 100000 : null);
  const images = ((item.images as string[] | undefined) ?? (item.image ? [item.image as string] : [])).map((h) => (h.startsWith("http") ? h : `https://down-my.img.susercontent.com/file/${h}`));
  const shopid = item.shopid as number | undefined;
  const itemid = item.itemid as number | undefined;
  const models = ((item.models as AnyRec[] | undefined) ?? []).map((m) => ({ title: (m.name as string) ?? "Variant", price: toMajor(m.price), sku: null, image: null, stock: (m.stock as number) ?? null }));
  const tiers = ((item.tier_variations as AnyRec[] | undefined) ?? []).map((t) => ({ name: (t.name as string) ?? "Option", values: ((t.options as string[] | undefined) ?? []).map(String) }));
  return {
    title: (item.name as string) ?? "Untitled",
    description: (item.description as string) ?? null,
    price: toMajor(item.price ?? item.price_min),
    currency: (item.currency as string) ?? null,
    compareAtPrice: toMajor(item.price_before_discount) || null,
    url: shopid && itemid ? `${origin}/product/${shopid}/${itemid}` : null,
    images,
    externalId: shopid && itemid ? `${shopid}.${itemid}` : null,
    soldCount: (item.historical_sold as number) ?? (item.sold as number) ?? null,
    rating: ((item.item_rating as AnyRec | undefined)?.rating_star as number) ?? null,
    ratingCount: (((item.item_rating as AnyRec | undefined)?.rating_count as number[] | undefined) ?? [])[0] ?? null,
    stock: (item.stock as number) ?? null,
    variants: models,
    options: tiers,
    category: null,
    via: "shopee-api",
    evidence,
    sourcePlatform: "shopee",
  };
}

/** Lazada: shop pages answer JSON when asked with ?ajax=true (mods.listItems). */
export const lazadaAjaxProvider: Provider = {
  id: "lazada-ajax",
  priority: 20,
  stage: "always",
  supports: (src) => src.platform === "lazada",
  async run(src, signals, ctx) {
    const u = new URL(src.url);
    const origin = u.origin;
    const common = { timeoutMs: ctx.config.fetchTimeoutMs, signal: ctx.signal, retries: 0, headers: { referer: src.url, "x-requested-with": "XMLHttpRequest" } };
    if (src.kind === "shop") {
      const shopPath = src.handle ? `/shop/${src.handle}/` : u.pathname;
      for (const endpoint of [`${origin}${shopPath}?ajax=true&from=wangpu&q=All-Products`, `${origin}${shopPath}?ajax=true`]) {
        const res = await fetchJson<AnyRec>(endpoint, common);
        const items = ((res.data?.mods as AnyRec | undefined)?.listItems as AnyRec[] | undefined) ?? [];
        if (res.ok && items.length) {
          for (const it of items) {
            const priceShow = (it.priceShow as string) ?? null;
            signals.products.push({
              title: (it.name as string) ?? "Untitled",
              description: null,
              price: typeof it.price === "string" ? Number(it.price) : ((it.price as number) ?? null),
              priceText: priceShow,
              currency: null,
              compareAtPrice: typeof it.originalPrice === "string" ? Number(it.originalPrice) : ((it.originalPrice as number) ?? null),
              url: typeof it.productUrl === "string" ? (it.productUrl.startsWith("//") ? "https:" + it.productUrl : it.productUrl) : null,
              images: typeof it.image === "string" ? [it.image] : [],
              externalId: it.itemId != null ? String(it.itemId) : null,
              rating: it.ratingScore ? Number(it.ratingScore) : null,
              ratingCount: it.review ? Number(it.review) : null,
              via: "lazada-ajax",
              evidence: endpoint,
              sourcePlatform: "lazada",
            });
          }
          const seller = (items[0]?.sellerName as string) ?? null;
          if (seller) {
            signals.profile = signals.profile ?? { name: null, handle: src.handle, bio: null, avatar: null, followers: null, verified: null, website: null };
            signals.profile.name = signals.profile.name ?? seller;
          }
          signals.status = "ok";
          return;
        }
        signals.errors.push(`lazada-ajax: ${res.error ?? (res.blocked ? "blocked" : "no items")}`);
      }
    }
    if (src.kind === "product") {
      const res = await fetchPageLadder(src.url, ["googlebot", "desktop"], { timeoutMs: ctx.config.fetchTimeoutMs, signal: ctx.signal });
      if (res.ok && !res.blocked) {
        const hunted = huntProductsInHtml(res.body, { platform: "lazada", baseUrl: res.finalUrl, via: "embedded-json", maxProducts: 5 });
        if (hunted.length) signals.products.push(...hunted.map((p) => ({ ...p, evidence: src.url, sourcePlatform: "lazada" as const })));
      }
    }
  },
};

/** Shopify stores expose /products.json publicly. Also probes generic websites that look like Shopify. */
export const shopifyProductsProvider: Provider = {
  id: "shopify-products-json",
  priority: 30,
  stage: "always",
  supports: (src) => src.platform === "shopify" || src.platform === "website",
  async run(src, signals, ctx) {
    const looksShopify = src.platform === "shopify" || /cdn\.shopify\.com|Shopify\.theme|myshopify|shopify-section/i.test(signals.text + signals.links.slice(0, 50).join(" ")) || signals.images.some((i) => i.includes("cdn.shopify.com")) || signals.openGraph["og:site_name"] !== undefined;
    if (!looksShopify) return;
    const origin = new URL(src.url).origin;
    const all: RawProduct[] = [];
    const PAGE = 100;
    for (let page = 1; page <= 6; page++) {
      const res = await fetchJson(`${origin}/products.json?limit=${PAGE}&page=${page}`, { timeoutMs: Math.max(ctx.config.fetchTimeoutMs, 30_000), signal: ctx.signal, retries: 0, maxBytes: 16 * 1024 * 1024 });
      if (!res.ok || !res.data) {
        if (page === 1) signals.errors.push(`shopify-products-json: ${res.error ?? "no data"}${res.status ? ` (HTTP ${res.status})` : ""}`);
        break;
      }
      const products = productsFromShopifyJson(res.data, origin).map((p) => ({ ...p, evidence: `${origin}/products.json`, sourcePlatform: "shopify" as const }));
      all.push(...products);
      if (products.length < PAGE) break;
    }
    if (all.length) {
      signals.products.push(...all);
      signals.platform = "shopify";
      signals.status = "ok";
      mergeUnique(signals.images, all.flatMap((p) => p.images ?? []).slice(0, 40));
      // Shopify stores usually expose currency in /meta.json
      const meta = await fetchJson<AnyRec>(`${origin}/meta.json`, { timeoutMs: ctx.config.fetchTimeoutMs, signal: ctx.signal, retries: 0 });
      if (meta.ok && meta.data) {
        signals.embedded.shopifyMeta = { name: meta.data.name, currency: meta.data.currency, country: meta.data.country, description: meta.data.description };
        for (const p of signals.products) if (!p.currency && typeof meta.data.currency === "string") p.currency = meta.data.currency;
      }
    }
  },
};

/** Facebook pages: public avatar via the Graph picture redirect; about page for contacts when not login-walled. */
export const facebookPublicProvider: Provider = {
  id: "facebook-public",
  priority: 20,
  stage: "always",
  supports: (src) => src.platform === "facebook" && (src.kind === "profile" || src.kind === "shop") && (!!src.handle || !!src.externalId),
  async run(src, signals, ctx) {
    const id = src.handle ?? src.externalId!;
    const pic = await fetchJson<AnyRec>(`https://graph.facebook.com/${encodeURIComponent(id)}/picture?type=large&redirect=false`, { timeoutMs: ctx.config.fetchTimeoutMs, signal: ctx.signal, retries: 0 });
    const url = (pic.data?.data as AnyRec | undefined)?.url as string | undefined;
    if (url && !/static\.xx\.fbcdn|silhouette/i.test(url)) {
      signals.profile = signals.profile ?? { name: null, handle: src.handle, bio: null, avatar: null, followers: null, verified: null, website: null };
      signals.profile.avatar = signals.profile.avatar ?? url;
      mergeUnique(signals.images, [url]);
    }
    const res = await fetchPage(`https://www.facebook.com/${encodeURIComponent(id)}/about`, { timeoutMs: ctx.config.fetchTimeoutMs, signal: ctx.signal, ua: "mobile", retries: 0 });
    if (!res.ok || res.blocked) {
      signals.errors.push(`facebook-public(about): ${res.error ?? "blocked"}`);
      return;
    }
    const meta = parseHtml(res.body, res.finalUrl);
    mergeUnique(signals.links, meta.links, 300);
    harvestContacts(signals, meta.text);
    if (meta.title && !signals.title) signals.title = meta.title;
  },
};

export const platformProviders: Provider[] = [tiktokOembedProvider, instagramProfileProvider, shopeeApiProvider, lazadaAjaxProvider, shopifyProductsProvider, facebookPublicProvider];
