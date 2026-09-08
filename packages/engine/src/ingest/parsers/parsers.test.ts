import { describe, expect, it } from "vitest";
import { orgFromJsonLd, parseHtml, productsFromJsonLd } from "./html.js";
import { extractTikTok, productsFromShopifyJson } from "./embedded.js";
import { guessCurrencyFromText, parsePrice } from "../../util/text.js";

const HTML = `<!doctype html><html lang="ms"><head>
<title>Kedai Kopi Aman | Shopee Malaysia</title>
<meta property="og:title" content="Kedai Kopi Aman">
<meta property="og:description" content="Kopi & matcha dari Ipoh. WhatsApp 0123456789">
<meta property="og:image" content="https://cdn.example.com/hero.jpg">
<meta property="og:site_name" content="Shopee">
<link rel="canonical" href="/kedaikopiaman">
<script type="application/ld+json">{"@context":"https://schema.org","@type":"Product","name":"Matcha Latte Kit","description":"Ceremonial grade","image":["https://cdn.example.com/matcha.jpg"],"sku":"MK-1","offers":{"@type":"Offer","price":"45.00","priceCurrency":"MYR","availability":"https://schema.org/InStock","url":"https://shopee.com.my/x-i.1.2"},"aggregateRating":{"ratingValue":4.8,"reviewCount":32}}</script>
<script type="application/ld+json">{"@type":"Organization","name":"Kedai Kopi Aman","logo":"https://cdn.example.com/logo.png","sameAs":["https://www.instagram.com/kopiaman"]}</script>
</head><body><nav>menu</nav><main><h1>Kedai Kopi Aman</h1><p>Best kopi in town.</p><img src="/img/p1.jpg"><a href="https://wa.me/60123456789">WhatsApp</a></main><script>var x=1</script></body></html>`;

describe("parseHtml", () => {
  it("extracts meta, images, links, text and json-ld", () => {
    const m = parseHtml(HTML, "https://shopee.com.my/kedaikopiaman");
    expect(m.title).toBe("Kedai Kopi Aman");
    expect(m.description).toContain("Ipoh");
    expect(m.siteName).toBe("Shopee");
    expect(m.canonical).toBe("https://shopee.com.my/kedaikopiaman");
    expect(m.images).toContain("https://cdn.example.com/hero.jpg");
    expect(m.images).toContain("https://shopee.com.my/img/p1.jpg");
    expect(m.links).toContain("https://wa.me/60123456789");
    expect(m.text).toContain("Best kopi in town.");
    expect(m.text).not.toContain("var x=1");
    expect(m.jsonLd).toHaveLength(2);
    expect(m.lang).toBe("ms");
  });

  it("maps json-ld products and organizations", () => {
    const m = parseHtml(HTML, "https://shopee.com.my/kedaikopiaman");
    const products = productsFromJsonLd(m.jsonLd);
    expect(products).toHaveLength(1);
    expect(products[0]).toMatchObject({ title: "Matcha Latte Kit", price: 45, currency: "MYR", externalId: "MK-1", rating: 4.8, ratingCount: 32, stock: 1 });
    expect(products[0].images).toEqual(["https://cdn.example.com/matcha.jpg"]);
    const org = orgFromJsonLd(m.jsonLd);
    expect(org).toMatchObject({ name: "Kedai Kopi Aman", logo: "https://cdn.example.com/logo.png" });
    expect(org?.sameAs).toContain("https://www.instagram.com/kopiaman");
  });
});

describe("embedded extractors", () => {
  it("reads TikTok universal data", () => {
    const data = { __DEFAULT_SCOPE__: { "webapp.user-detail": { userInfo: { user: { uniqueId: "kopiaman", nickname: "Kedai Kopi Aman", signature: "Kopi from Ipoh ☕", avatarLarger: "https://p16.tiktokcdn.com/a.jpeg", verified: false, bioLink: { link: "https://linktr.ee/kopiaman" } }, stats: { followerCount: 12000, heartCount: 500000 } } } } };
    const html = `<html><body><script id="__UNIVERSAL_DATA_FOR_REHYDRATION__" type="application/json">${JSON.stringify(data)}</script></body></html>`;
    const e = extractTikTok(html);
    expect(e.profile).toMatchObject({ handle: "kopiaman", name: "Kedai Kopi Aman", followers: 12000, website: "https://linktr.ee/kopiaman" });
    expect(e.images).toContain("https://p16.tiktokcdn.com/a.jpeg");
  });

  it("maps Shopify products.json", () => {
    const json = { products: [{ id: 1, title: "Mug", handle: "mug", body_html: "<p>Nice <b>mug</b></p>", product_type: "Home", tags: "ceramic, gift", variants: [{ title: "Default Title", price: "58.00", compare_at_price: "70.00", available: true, sku: "M1" }], images: [{ src: "https://cdn.shopify.com/m.jpg" }], options: [{ name: "Title", values: ["Default Title"] }] }] };
    const p = productsFromShopifyJson(json, "https://kopiaman.com");
    expect(p[0]).toMatchObject({ title: "Mug", price: 58, compareAtPrice: 70, url: "https://kopiaman.com/products/mug", category: "Home", description: "Nice mug" });
    expect(p[0].options).toEqual([]);
    expect(p[0].tags).toEqual(["ceramic", "gift"]);
  });
});

describe("price helpers", () => {
  it("parses regional prices", () => {
    expect(parsePrice("RM 25.90")).toBe(25.9);
    expect(parsePrice("Rp150.000")).toBe(150000);
    expect(parsePrice("1,299.00")).toBe(1299);
    expect(parsePrice("$12")).toBe(12);
    expect(guessCurrencyFromText("RM 25.90")).toBe("MYR");
    expect(guessCurrencyFromText("Rp150.000")).toBe("IDR");
    expect(guessCurrencyFromText("S$ 12")).toBe("SGD");
    expect(guessCurrencyFromText("₱ 499")).toBe("PHP");
    expect(guessCurrencyFromText("$12")).toBe("USD");
  });
});
