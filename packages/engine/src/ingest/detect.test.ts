import { describe, expect, it } from "vitest";
import { appDeepLinkToWeb, classifyUrl, detectInput, regionFromShortHost, SHOPEE_SHORT_HOST } from "./detect.js";

describe("classifyUrl", () => {
  it("classifies TikTok profiles, videos and shop links", () => {
    expect(classifyUrl("https://www.tiktok.com/@kedai.kopi?lang=en")).toMatchObject({ platform: "tiktok", kind: "profile", handle: "kedai.kopi" });
    expect(classifyUrl("tiktok.com/@brand/video/7301234567890123456")).toMatchObject({ platform: "tiktok", kind: "post", handle: "brand", externalId: "7301234567890123456" });
    expect(classifyUrl("https://shop.tiktok.com/view/product/1729876543210?region=MY")).toMatchObject({ platform: "tiktok_shop", kind: "product", externalId: "1729876543210" });
    expect(classifyUrl("https://vt.tiktok.com/ZSabc123/")).toMatchObject({ platform: "tiktok", kind: "post" });
  });

  it("classifies Instagram", () => {
    expect(classifyUrl("https://www.instagram.com/glowlab.my/")).toMatchObject({ platform: "instagram", kind: "profile", handle: "glowlab.my" });
    expect(classifyUrl("https://www.instagram.com/p/Cxyz123/?igsh=abc")).toMatchObject({ platform: "instagram", kind: "post", externalId: "Cxyz123" });
    expect(classifyUrl("https://www.instagram.com/reel/Cabc/")).toMatchObject({ platform: "instagram", kind: "post" });
  });

  it("classifies Shopee across regions", () => {
    expect(classifyUrl("https://shopee.com.my/kedaikopiaman")).toMatchObject({ platform: "shopee", kind: "shop", handle: "kedaikopiaman", region: "my" });
    expect(classifyUrl("https://shopee.sg/Matcha-Kit-i.12345.67890")).toMatchObject({ platform: "shopee", kind: "product", externalId: "12345.67890", region: "sg" });
    expect(classifyUrl("https://shopee.co.id/product/111/222")).toMatchObject({ platform: "shopee", kind: "product", externalId: "111.222", region: "id" });
    expect(classifyUrl("https://shopee.ph/shop/98765")).toMatchObject({ platform: "shopee", kind: "shop", externalId: "98765", region: "ph" });
  });

  /**
   * Links copied from the Shopee app's share sheet. These classified as a plain website before,
   * so a pasted app link reached no Shopee provider at all and the job recorded no URLs.
   */
  it("classifies Shopee share-sheet short links and their market", () => {
    expect(classifyUrl("https://my.shp.ee/DMJnpYqg")).toMatchObject({ platform: "shopee", kind: "shop", region: "my" });
    expect(classifyUrl("https://sg.shope.ee/abc")).toMatchObject({ platform: "shopee", kind: "shop", region: "sg" });
    expect(classifyUrl("https://shp.ee/abc")).toMatchObject({ platform: "shopee", kind: "shop", region: null });
    expect(regionFromShortHost("my.shp.ee")).toBe("my");
    expect(regionFromShortHost("shp.ee")).toBeNull();
    expect(SHOPEE_SHORT_HOST.test("shopee.com.my")).toBe(false);
  });

  it("classifies Facebook and Lazada and Shopify", () => {
    expect(classifyUrl("https://www.facebook.com/kedaikopiaman")).toMatchObject({ platform: "facebook", kind: "profile", handle: "kedaikopiaman" });
    expect(classifyUrl("https://www.facebook.com/marketplace/item/123456")).toMatchObject({ platform: "facebook", kind: "product", externalId: "123456" });
    expect(classifyUrl("https://www.lazada.com.my/shop/kopi-aman")).toMatchObject({ platform: "lazada", kind: "shop", handle: "kopi-aman", region: "my" });
    expect(classifyUrl("https://www.lazada.com.my/products/matcha-kit-i123456789-s987.html")).toMatchObject({ platform: "lazada", kind: "product", externalId: "123456789" });
    expect(classifyUrl("https://kopiaman.myshopify.com/products/matcha-kit")).toMatchObject({ platform: "shopify", kind: "product", handle: "matcha-kit" });
    expect(classifyUrl("https://kopiaman.com")).toMatchObject({ platform: "website", kind: "website" });
  });

  it("strips tracking params and normalizes", () => {
    expect(classifyUrl("www.instagram.com/brand/?utm_source=x&igsh=abc")?.url).toBe("https://www.instagram.com/brand/");
  });
});

describe("appDeepLinkToWeb", () => {
  it("turns TikTok app deep links into shop and product web links", () => {
    expect(appDeepLinkToWeb("snssdk1180://ec/store?sellerId=7494487462872581384&store_page_version=1&share_region=MY")).toBe("https://www.tiktok.com/shop/store/7494487462872581384?region=MY");
    expect(classifyUrl("https://www.tiktok.com/shop/store/7494487462872581384?region=MY")).toMatchObject({ platform: "tiktok_shop", kind: "shop", externalId: "7494487462872581384", region: "my" });
    expect(appDeepLinkToWeb("snssdk1180://ec/pdp?product_id=1737407560208582560")).toBe("https://www.tiktok.com/view/product/1737407560208582560");
    expect(appDeepLinkToWeb("snssdk1180://profile?uid=1")).toBeNull();
  });
});

describe("detectInput", () => {
  it("splits links and product lines", () => {
    const det = detectInput("https://www.tiktok.com/@brand\nMatcha Latte Kit - RM 45\nhttps://shopee.com.my/brand extra words here that matter\n\n");
    expect(det.urls.map((u) => u.platform)).toEqual(["tiktok", "shopee"]);
    expect(det.texts).toContain("Matcha Latte Kit - RM 45");
    expect(det.texts.some((t) => t.includes("extra words"))).toBe(true);
  });

  it("dedupes repeated links", () => {
    const det = detectInput("tiktok.com/@a\nhttps://www.tiktok.com/@a");
    expect(det.urls).toHaveLength(1);
  });
});
