/**
 * Minimal StoreSpec types for templates. Mirrors @nexova/engine's schema/store-spec.ts
 * (kept dependency-free so templates build standalone).
 */
export interface NxImage {
  url: string;
  alt: string;
  width: number | null;
  height: number | null;
  sourceUrl: string | null;
}
export interface NxMoney {
  amount: number;
  currency: string;
}
export interface NxVariant {
  id: string;
  title: string;
  options: Record<string, string>;
  price: NxMoney | null;
  compareAtPrice: NxMoney | null;
  sku: string | null;
  image: NxImage | null;
  inventory: { track: boolean; quantity: number | null; status: string };
}
export interface NxProduct {
  id: string;
  slug: string;
  title: string;
  description: string;
  shortDescription: string;
  price: NxMoney;
  compareAtPrice: NxMoney | null;
  images: NxImage[];
  options: Array<{ name: string; values: string[] }>;
  variants: NxVariant[];
  inventory: { track: boolean; quantity: number | null; status: string };
  categories: string[];
  tags: string[];
  attributes: Record<string, string>;
  featured: boolean;
  rating: { average: number; count: number } | null;
  soldCount: number | null;
  source: { platform: string; url: string | null; externalId: string | null };
  confidence: number;
  visible: boolean;
}
export interface NxCategory {
  slug: string;
  name: string;
  description: string;
  image: NxImage | null;
}
export interface NxStore {
  version: number;
  id: string;
  slug: string;
  brand: {
    name: string;
    handle: string | null;
    tagline: string;
    description: string;
    story: string;
    logo: NxImage | null;
    avatar: NxImage | null;
    heroImage: NxImage | null;
    industry: string;
    tone: string;
    values: string[];
    location: { country: string | null; city: string | null };
    contact: { email: string | null; phone: string | null; whatsapp: string | null; address: string | null };
    followers: number | null;
  };
  theme: {
    preset: string;
    mode: "light" | "dark";
    colors: Record<string, string>;
    fonts: { heading: string; body: string };
    radius: string;
  };
  social: Record<string, string | null>;
  catalog: { products: NxProduct[]; categories: NxCategory[]; collections: Array<{ slug: string; name: string; description: string; productIds: string[] }> };
  pages: {
    home: {
      heroTitle: string;
      heroSubtitle: string;
      heroCta: string;
      announcement: string;
      featuredProductIds: string[];
      sections: Array<{ type: string; title: string; subtitle: string }>;
      usps: Array<{ title: string; text: string }>;
    };
    about: { title: string; body: string };
    faq: Array<{ question: string; answer: string }>;
    testimonials: Array<{ author: string; text: string; rating: number | null; source: string | null }>;
    contact: { title: string; body: string };
  };
  commerce: {
    currency: string;
    locale: string;
    checkout: { mode: "whatsapp" | "external_link" | "stripe" | "none"; whatsappNumber: string | null; externalUrl: string | null };
    shipping: { note: string; regions: string[]; freeShippingThreshold: number | null };
    policies: { returns: string; privacy: string; terms: string };
  };
  seo: { title: string; description: string; keywords: string[]; ogImage: string | null };
}
