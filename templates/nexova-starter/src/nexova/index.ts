import storeJson from "./store.json";
import type { NxImage, NxMoney, NxProduct, NxStore } from "./types";

export const store = storeJson as unknown as NxStore;

/** Resolve an image URL from the spec: remote URLs pass through, local assets get the base path. */
export function assetUrl(img: NxImage | string | null | undefined): string {
  const url = typeof img === "string" ? img : img?.url;
  if (!url) return "";
  if (/^(https?:)?\/\//i.test(url) || url.startsWith("data:")) return url;
  const base = import.meta.env.BASE_URL.endsWith("/") ? import.meta.env.BASE_URL : import.meta.env.BASE_URL + "/";
  return base + url.replace(/^\//, "");
}

const ZERO_DECIMAL = new Set(["IDR", "VND", "JPY", "KRW", "CLP", "HUF"]);

export function formatPrice(money: NxMoney | null | undefined, locale = store.commerce.locale): string {
  if (!money) return "";
  const currency = money.currency || store.commerce.currency;
  const digits = ZERO_DECIMAL.has(currency) ? 0 : 2;
  try {
    return new Intl.NumberFormat(locale || "en", { style: "currency", currency, minimumFractionDigits: digits, maximumFractionDigits: digits }).format(money.amount);
  } catch {
    return `${currency} ${money.amount.toFixed(digits)}`;
  }
}

export function visibleProducts(): NxProduct[] {
  return store.catalog.products.filter((p) => p.visible !== false);
}

export function featuredProducts(): NxProduct[] {
  const ids = store.pages.home.featuredProductIds;
  const byId = new Map(visibleProducts().map((p) => [p.id, p]));
  const featured = ids.map((id) => byId.get(id)).filter((p): p is NxProduct => !!p);
  if (featured.length) return featured;
  return visibleProducts().filter((p) => p.images.length).slice(0, 8);
}

export function productBySlug(slug: string): NxProduct | undefined {
  return store.catalog.products.find((p) => p.slug === slug);
}

export function productsInCategory(slug: string): NxProduct[] {
  return visibleProducts().filter((p) => p.categories.includes(slug));
}

export function placeholderImage(title: string): string {
  const initials = title
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? "")
    .join("");
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='800' height='800'><rect width='100%' height='100%' fill='#e9e9ee'/><text x='50%' y='50%' dominant-baseline='middle' text-anchor='middle' font-family='sans-serif' font-size='160' fill='#9a9aa5'>${initials || "?"}</text></svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

export interface CartLine {
  productId: string;
  variantId: string | null;
  qty: number;
}

const CART_KEY = `nexova-cart:${store.slug}`;

export function loadCart(): CartLine[] {
  try {
    return JSON.parse(localStorage.getItem(CART_KEY) || "[]");
  } catch {
    return [];
  }
}

export function saveCart(lines: CartLine[]): void {
  try {
    localStorage.setItem(CART_KEY, JSON.stringify(lines));
  } catch {
    /* ignore */
  }
}

export function checkoutUrl(lines: CartLine[]): { href: string; label: string } | null {
  const c = store.commerce.checkout;
  if (c.mode === "whatsapp" && c.whatsappNumber) {
    const items = lines
      .map((l) => {
        const p = store.catalog.products.find((x) => x.id === l.productId);
        if (!p) return null;
        const v = l.variantId ? p.variants.find((x) => x.id === l.variantId) : null;
        return `- ${p.title}${v ? ` (${v.title})` : ""} x${l.qty} — ${formatPrice(v?.price ?? p.price)}`;
      })
      .filter(Boolean)
      .join("\n");
    const text = `Hi ${store.brand.name}! I would like to order:\n${items}\n\nSent from ${store.brand.name} online store.`;
    return { href: `https://wa.me/${c.whatsappNumber}?text=${encodeURIComponent(text)}`, label: "Order on WhatsApp" };
  }
  if (c.mode === "external_link" && c.externalUrl) return { href: c.externalUrl, label: "Buy on our marketplace" };
  const first = lines[0] && store.catalog.products.find((x) => x.id === lines[0].productId);
  if (first?.source.url) return { href: first.source.url, label: "Buy on " + prettyPlatform(first.source.platform) };
  return null;
}

export function prettyPlatform(p: string): string {
  return ({ tiktok: "TikTok", tiktok_shop: "TikTok Shop", instagram: "Instagram", facebook: "Facebook", shopee: "Shopee", lazada: "Lazada", shopify: "our website", website: "our website" } as Record<string, string>)[p] ?? p;
}
