/**
 * Draft schemas are what Claude is asked to produce via structured outputs.
 *
 * They are intentionally flatter than StoreSpec and follow the structured-output rules:
 *  - every field required (no optionals)
 *  - no records / maps (use arrays of {name, value})
 *  - no defaults, no numeric or string constraints, no recursion
 *
 * They also avoid nullable/union fields. The API caps a schema at 16 union-typed parameters
 * ("too many parameters with type arrays or anyOf"), and nullable-everything blows past that on
 * a schema this wide. Instead, absence is expressed with sentinels that are natural for the field:
 * an empty string for unknown text, 0 for an unknown count, and "keep" for "do not change this".
 * `schema/sentinels.ts` converts them back to real nulls.
 *
 * The engine maps drafts -> StoreSpec in claude/mapping.ts.
 */
import { z } from "zod";

export const NameValueSchema = z.object({ name: z.string(), value: z.string() });

export const MoneyDraftSchema = z.object({
  amount: z.number().describe("Price in major units, e.g. 25.9"),
  currency: z.string().describe("ISO 4217 code such as MYR, SGD, USD, IDR, PHP, THB, VND"),
});

export const ImageRefSchema = z.object({
  url: z.string().describe("Absolute http(s) URL exactly as seen in the sources; never invent URLs"),
  alt: z.string(),
});

const PlatformDraftEnum = z.enum(["tiktok", "tiktok_shop", "instagram", "facebook", "shopee", "lazada", "shopify", "website", "text", "unknown"]);

/**
 * Facts only. Design and copy live in EnrichmentDraft: a schema covering both compiles into a
 * grammar the API rejects as too large, and splitting them also stops the two steps disagreeing.
 */
export const StoreDraftSchema = z.object({
  brand: z.object({
    name: z.string().describe("The shop or brand name as customers know it"),
    handle: z.string().describe("Primary social handle without @; empty string if unknown"),
    tagline: z.string().describe("Short punchy tagline, max ~8 words"),
    description: z.string().describe("2-4 sentences describing what the brand sells and for whom"),
    industry: z.string().describe("One of: fashion, beauty, food, home, electronics, handmade, health, kids, pets, sports, accessories, digital, services, other"),
    tone: z.string().describe("Voice for copy: e.g. playful, premium, minimal, warm, bold"),
    logoUrl: z.string().describe("Image URL seen in the sources, or empty string"),
    avatarUrl: z.string().describe("Profile picture URL seen in the sources, or empty string"),
    heroImageUrl: z.string().describe("Best wide image for the homepage hero, or empty string"),
    country: z.string().describe("ISO 3166 alpha-2 if known, e.g. MY, SG, ID; empty string otherwise"),
    city: z.string(),
    email: z.string(),
    phone: z.string(),
    whatsapp: z.string().describe("International number with country code, digits only; empty string if none"),
    address: z.string(),
    followers: z.number().describe("Follower count if known, otherwise 0"),
  }),
  social: z
    .object({
      tiktok: z.string(),
      tiktokShop: z.string(),
      instagram: z.string(),
      facebook: z.string(),
      shopee: z.string(),
      lazada: z.string(),
      whatsapp: z.string(),
      telegram: z.string(),
      youtube: z.string(),
      x: z.string(),
      website: z.string(),
    })
    .describe("Full URLs where known, empty string where not. Only the merchant's own accounts, never the marketplace's."),
  commerce: z.object({
    currency: z.string().describe("ISO 4217 code used for the store"),
    locale: z.string().describe("BCP 47 tag like en, ms, id, th, vi, zh"),
    checkoutMode: z.enum(["whatsapp", "external_link", "none"]).describe("whatsapp when a WhatsApp number exists; external_link when products link to a marketplace; otherwise none"),
    externalCheckoutUrl: z.string().describe("Marketplace shop URL to send buyers to, or empty string"),
    shippingNote: z.string(),
    shippingRegions: z.array(z.string()),
    returnsPolicy: z.string(),
  }),
  categories: z
    .array(
      z.object({
        slug: z.string().describe("kebab-case"),
        name: z.string(),
        description: z.string(),
      }),
    )
    .describe("3-8 categories that group the products sensibly"),
  warnings: z.array(z.string()).describe("Anything the merchant should double check, e.g. prices guessed, images missing"),
  confidence: z.number().describe("0..1 overall confidence that this reflects the real business"),
});
export type StoreDraft = z.infer<typeof StoreDraftSchema>;

export const ProductDraftSchema = z.object({
  title: z.string(),
  description: z.string().describe("Full description in plain text; keep facts from sources, do not invent specs"),
  shortDescription: z.string().describe("One or two sentences for product cards"),
  price: MoneyDraftSchema,
  compareAtPrice: z.number().describe("Original price before discount in the same currency, or 0 when there is no discount"),
  images: z.array(ImageRefSchema).describe("Only URLs present in the sources"),
  options: z.array(z.object({ name: z.string(), values: z.array(z.string()) })),
  variants: z.array(
    z.object({
      title: z.string(),
      options: z.array(NameValueSchema),
      price: z.number().describe("Variant price, or 0 to use the product price"),
      sku: z.string(),
      imageUrl: z.string(),
    }),
  ),
  categorySlugs: z.array(z.string()).describe("Slugs from the categories list"),
  tags: z.array(z.string()),
  attributes: z.array(NameValueSchema),
  inventoryStatus: z.enum(["in_stock", "low_stock", "out_of_stock", "preorder", "unknown"]),
  rating: z.number().describe("Average rating 1-5, or 0 if unknown"),
  ratingCount: z.number().describe("Number of ratings, or 0"),
  soldCount: z.number().describe("Units sold, or 0 if unknown"),
  sourceUrl: z.string().describe("Product page URL, or empty string"),
  sourcePlatform: PlatformDraftEnum,
  externalId: z.string(),
  featured: z.boolean(),
  confidence: z.number().describe("0..1; below 0.4 means the item may not be a real product for sale"),
});
export type ProductDraft = z.infer<typeof ProductDraftSchema>;

export const ProductBatchDraftSchema = z.object({
  products: z.array(ProductDraftSchema),
  notes: z.string().describe("Short note on what was dropped or merged and why"),
});
export type ProductBatchDraft = z.infer<typeof ProductBatchDraftSchema>;

export const AttachmentItemDraftSchema = z.object({
  imageIndex: z.number().describe("0-based index of the screenshot in the order given"),
  platform: PlatformDraftEnum.describe("Which app/site the screenshot shows"),
  pageType: z.enum(["shop", "product_list", "product", "profile", "cart", "chat", "spreadsheet", "other"]),
  shopName: z.string(),
  handle: z.string().describe("Username/handle without @ if visible, else empty string"),
  bio: z.string(),
  followers: z.number().describe("Follower count if visible, else 0"),
  rating: z.number().describe("Shop rating out of 5 if visible, else 0"),
  location: z.string(),
  whatsapp: z.string().describe("Digits with country code, or empty string"),
  email: z.string(),
  phone: z.string(),
  website: z.string(),
  socialHandles: z.array(z.object({ platform: PlatformDraftEnum, handle: z.string() })),
  products: z.array(
    z.object({
      title: z.string(),
      priceText: z.string().describe("Price exactly as shown, e.g. RM25.90 or Rp150.000; empty string if not visible"),
      price: z.number().describe("Numeric price in major units, or 0 if not readable"),
      currency: z.string().describe("ISO code inferred from the symbol/app region, or empty string"),
      compareAtPrice: z.number().describe("Struck-through original price, or 0"),
      soldCount: z.number().describe("Parsed from labels like '1.2k sold', or 0"),
      rating: z.number().describe("1-5, or 0"),
      variants: z.array(z.string()).describe("Visible variant names, e.g. sizes/colours"),
      stockText: z.string(),
      description: z.string().describe("Only text visible in the image"),
      readable: z.boolean().describe("false if the title or price is cut off or blurry"),
    }),
  ),
  visibleText: z.string().describe("Short transcription of other useful text (promos, shipping, policies)"),
  notes: z.string(),
  confidence: z.number().describe("0..1 how reliable this extraction is"),
});

export const AttachmentBatchDraftSchema = z.object({
  items: z.array(AttachmentItemDraftSchema).describe("Exactly one item per screenshot, in order"),
});
export type AttachmentBatchDraft = z.infer<typeof AttachmentBatchDraftSchema>;

/** "keep" means: leave whatever the engine already decided. */
const KeepPreset = z.enum(["keep", "clean", "bold", "editorial", "playful", "luxe", "minimal", "organic", "tech"]);
const KeepMode = z.enum(["keep", "light", "dark"]);
const KeepRadius = z.enum(["keep", "none", "sm", "md", "lg", "full"]);

/**
 * Design and copy. This step owns the store's look and voice; normalization owns the facts.
 * Empty string / "keep" means "leave what the engine already chose".
 */
export const EnrichmentDraftSchema = z.object({
  brand: z
    .object({
      tagline: z.string(),
      description: z.string(),
      story: z.string().describe("About-us paragraph, 3-6 sentences in the brand voice, facts only"),
      tone: z.string(),
    })
    .describe("Only fill fields you want to improve; an empty string keeps the existing value"),
  theme: z.object({
    preset: KeepPreset,
    mode: KeepMode,
    primary: z.string().describe("hex color, or empty string to keep"),
    secondary: z.string(),
    accent: z.string(),
    background: z.string(),
    surface: z.string(),
    text: z.string(),
    headingFont: z.string(),
    bodyFont: z.string(),
    radius: KeepRadius,
    rationale: z.string(),
  }),
  home: z.object({
    heroTitle: z.string(),
    heroSubtitle: z.string(),
    heroCta: z.string(),
    announcement: z.string(),
    featuredProductIds: z.array(z.string()),
    sections: z
      .array(
        z.object({
          type: z.enum(["featured", "categories", "story", "testimonials", "faq", "newsletter", "socials", "usp"]),
          title: z.string(),
          subtitle: z.string(),
        }),
      )
      .describe("Ordered homepage sections after the hero"),
    usps: z.array(z.object({ title: z.string(), text: z.string() })),
  }),
  faq: z.array(z.object({ question: z.string(), answer: z.string() })).describe("4-6 practical FAQs (ordering, shipping, returns, contact); empty array keeps the defaults"),
  seo: z.object({ title: z.string(), description: z.string(), keywords: z.array(z.string()) }),
  templateChoice: z.object({
    templateId: z.string().describe("id from the available templates list"),
    reason: z.string(),
  }),
  warnings: z.array(z.string()),
});
export type EnrichmentDraft = z.infer<typeof EnrichmentDraftSchema>;
