# Nexova — What to do next

Ordered by priority. Each item is small enough to finish in one sitting unless marked otherwise. Tick items off in place.

## Now (unblock the core promise: paste a TikTok Shop link, get a store)

- [ ] **Commit the TikTok Shop API work.** The provider, tests, fixtures, config, docs, and PRD are all uncommitted on `main`. Review the diff, then commit. Leave the two lockfile changes out unless you intend to move to Node 20 lockfiles.
- [ ] **Add the GitHub remote** so the repo can push again: `git remote add origin https://github.com/scopie-io/nexova-v3`.
- [ ] **Restore TikTok Shop API quota.** The RapidAPI BASIC plan's monthly quota is exhausted. Upgrade the plan or wait for the reset. Until then, TikTok Shop links fall back to scraping and return almost nothing.
- [ ] **Run one real end-to-end build** once quota is back: paste `https://www.tiktok.com/shop/store/goli-nutrition/7495794203056835079`, confirm the store goes live with real products, photos, and the Goli profile, and read the coverage report. Then do the same with a Malaysian shop so the `MY` region path is exercised.
- [ ] **Rotate the RapidAPI key.** It was pasted into chat and into an MCP config. Generate a new one in RapidAPI, update `.env` and the `tiktok-shop-api` MCP entry.
- [ ] **Decide the default region order** (`NEXOVA_TIKTOK_SHOP_REGIONS`, currently `MY,SG,US`). Each miss costs a credit. See PRD open question 1.

## Next (make the generated store worth showing)

- [ ] **Render TikTok Shop reviews as testimonials.** The provider already stores up to 12 reviews in `signals.embedded.tiktokShopReviews`. Feed them into the enrichment prompt and the `pages.testimonials` section of `StoreSpec` so the store shows real social proof.
- [ ] **Use the seller's shop stats in copy.** Sold count, follower count, and shop rating are in `signals.embedded.tiktokShop`. Surface them as USPs ("598K followers, 5.7M sold").
- [ ] **Infer region from sibling links.** A pasted `shopee.com.my` link tells us the TikTok Shop is almost certainly `MY`. Pass a region hint from the job's other URLs into the provider before it starts probing.
- [ ] **Add templates.** Only `nexova-starter` exists; the engine and UI are built for ten. Start with three that cover the target merchants: beauty and skincare, food and drink, fashion. Follow `docs/TEMPLATE_CONTRACT.md`. This is the largest item on the list.
- [ ] **Buy button for TikTok Shop products.** Set `commerce.checkout.externalLink` to the product's TikTok Shop URL when the merchant has no WhatsApp number, so every product is purchasable on day one.
- [ ] **Show the TikTok Shop API status in the web app.** Health already returns `tiktokShopApi`. Show "TikTok Shop: connected" or a quota warning next to the model badge so operators see it before building.

## Soon (reliability and cost)

- [ ] **Move to Node 22 LTS.** Vitest 5 warns on Node 20. Set `"engines": { "node": ">=22" }`, add `.nvmrc`, regenerate lockfiles once.
- [ ] **Credit budget per job.** Add `NEXOVA_TIKTOK_SHOP_MAX_CALLS` as a hard cap across catalog pages, details, and region probes, and report calls used in the job summary.
- [ ] **Check quota cheaply before building.** One call to the API at job start; if it returns 429, skip the provider for all URLs in the job instead of failing per URL.
- [ ] **Reviews endpoint.** `/shop/reviews` exists on the API but is not used. Decide whether product-level reviews are worth a credit each; if so, fetch them only for featured products.
- [ ] **Retry policy for RapidAPI.** The provider uses `retries: 0`. Add one retry on 5xx and network errors, never on 4xx.
- [ ] **Test the region fallback live.** Confirm the "Resource not found" message is stable across regions and that a wrong-region miss does not get cached.

## Later (product scope from the PRD)

- [ ] **Inventory and copy editor** in the web app, on top of the existing `PUT /api/stores/:slug/spec` and product endpoints.
- [ ] **Custom domains and a hosted deploy target** beyond local and Netlify.
- [ ] **Shopee catalog via a paid API**, the same way as TikTok Shop, since Shopee's public endpoints are heavily rate-limited.
- [ ] **Merchant confirmation for creator showcase products** before they appear in a store (PRD open question 3).
- [ ] **Merchant accounts and official connectors** (TikTok Shop Partner API, Shopee Open Platform) for v1.0.

## Housekeeping

- [ ] Add a `CLAUDE.md` so future sessions know the build, test, and doctor commands and the credit-cost rule for the TikTok Shop API.
- [ ] Add a GitHub Actions workflow: typecheck, engine tests, build, on every push.
- [ ] Decide whether `.mcp.json` should be committed with `${RAPIDAPI_KEY}` so teammates get the MCP server without the key in git.
- [ ] Remove `install-autostart.cmd` and `start.cmd` from the README's top billing if the primary target is no longer a merchant's Windows PC (PRD open question 4).
