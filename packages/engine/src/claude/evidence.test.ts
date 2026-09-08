import { describe, expect, it } from "vitest";
import { emptySignals } from "../schema/signals.js";
import { classifyUrl } from "../ingest/detect.js";
import { evidenceFromSignals, reviewerDisplayName } from "./mapping.js";

function tiktokShopSource() {
  const det = classifyUrl("https://www.tiktok.com/shop/store/goli-nutrition/7495794203056835079")!;
  const s = emptySignals(det, det.url, "src_1");
  s.status = "ok";
  s.embedded.tiktokShop = { shopId: "7495794203056835079", region: "US", shopRating: 4.6, productCount: 52, soldCount: 5728730, reviewCount: 407079, responseRate: 99, followers: 598143, background: "https://cdn/bg.webp" };
  s.embedded.tiktokShopReviews = [
    { author: "Aisha", rating: 5, text: "I got my package very fast after ordering and can already feel the difference. Highly recommend.", source: "Purchased on TikTok" },
    { author: null, rating: 5, text: "Tastes great, works well, and shipping was quick. Will order again for sure.", source: "Purchased on TikTok" },
    { author: "Ben", rating: 2, text: "Did not like the texture at all, would not buy again, sorry to say that.", source: "Purchased on TikTok" },
    { author: "Cara", rating: 5, text: "Nice.", source: "Purchased on TikTok" },
    { author: "Dup", rating: 5, text: "I got my package very fast after ordering and can already feel the difference. Highly recommend.", source: "Purchased on TikTok" },
  ];
  return s;
}

describe("reviewerDisplayName", () => {
  it("strips emoji and decorations and falls back when nothing readable is left", () => {
    expect(reviewerDisplayName("XgHoSt | Producer🎵🎼")).toBe("XgHoSt");
    expect(reviewerDisplayName("Big*Tee♎️💎🌷😘👄")).toBe("Big Tee");
    expect(reviewerDisplayName("🍄 🐸 🐈‍⬛ ~* KD *~🐈‍⬛🐸🍄🦌")).toBe("KD");
    expect(reviewerDisplayName("🔥🔥🔥")).toBe("TikTok Shop customer");
    expect(reviewerDisplayName(null)).toBe("TikTok Shop customer");
    expect(reviewerDisplayName("a very long username that keeps going")).toBe("a very long username t…");
  });
});

describe("evidenceFromSignals", () => {
  it("turns real reviews into testimonials, skipping low ratings, stubs and duplicates", () => {
    const e = evidenceFromSignals([tiktokShopSource()]);
    expect(e.testimonials).toHaveLength(2);
    expect(e.testimonials[0]).toMatchObject({ author: "Aisha", rating: 5, source: "Purchased on TikTok" });
    expect(e.testimonials[1].author).toBe("TikTok Shop customer");
  });

  it("writes USPs from shop stats with compact numbers", () => {
    const e = evidenceFromSignals([tiktokShopSource()]);
    expect(e.usps.map((u) => u.title)).toEqual(["5.7M orders sold", "Rated 4.6/5", "598K followers on TikTok", "99% chat response rate"]);
    expect(e.usps[1].text).toContain("407K");
  });

  it("points Buy at the marketplace shop when there is nothing else", () => {
    expect(evidenceFromSignals([tiktokShopSource()]).marketplaceUrl).toBe("https://www.tiktok.com/shop/store/goli-nutrition/7495794203056835079");
    const det = classifyUrl("https://shop.tiktok.com/us/pdp/1729527313880355335")!;
    const productOnly = emptySignals(det, det.url, "src_2");
    productOnly.embedded.tiktokShop = { shopId: "7495794203056835079" };
    expect(evidenceFromSignals([productOnly]).marketplaceUrl).toBe("https://www.tiktok.com/shop/store/7495794203056835079");
  });

  it("is empty for sources without social proof", () => {
    const det = classifyUrl("https://www.instagram.com/brand/")!;
    const e = evidenceFromSignals([emptySignals(det, det.url, "src_3")]);
    expect(e).toEqual({ testimonials: [], usps: [], marketplaceUrl: null });
  });
});
