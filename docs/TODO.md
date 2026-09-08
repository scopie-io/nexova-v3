# Nexova — What to do next

Ordered by priority. Each item is small enough to finish in one sitting unless marked otherwise. Tick items off in place.

## Now (unblock the core promise: paste a TikTok Shop link, get a store)

- [x] **Commit the TikTok Shop API work.** The provider, tests, fixtures, config, docs, and PRD are all uncommitted on `main`. Review the diff, then commit. Leave the two lockfile changes out unless you intend to move to Node 20 lockfiles.
- [x] **Add the GitHub remote** so the repo can push again: `git remote add origin https://github.com/scopie-io/nexova-v3`.
- [x] **Restore TikTok Shop API quota.** The RapidAPI BASIC plan's monthly quota is exhausted. Upgrade the plan or wait for the reset. Until then, TikTok Shop links fall back to scraping and return almost nothing.
- [x] **Run one real end-to-end build** with the Goli store: live with 52 products, photos, profile, coverage 90%, USD 2.32 / 11 credits.
- [ ] **Run a build with a Malaysian shop** so the `MY` region path and MYR currency are exercised.
- [ ] **Rotate the RapidAPI key.** It was pasted into chat and into an MCP config. Generate a new one in RapidAPI, update `.env` and the `tiktok-shop-api` MCP entry.
- [ ] **Decide the default region order** (`NEXOVA_TIKTOK_SHOP_REGIONS`, currently `MY,SG,US`). Each miss costs a credit. See PRD open question 1.

## Next (make the generated store worth showing)

- [x] **Render TikTok Shop reviews as testimonials.** Done deterministically in `evidenceFromSignals`; reviewer names sanitized.
- [x] **Use the seller's shop stats in copy.** Stat-based USPs from `evidenceFromSignals`; enrichment keeps the numbers.
- [ ] **Infer region from sibling links.** A pasted `shopee.com.my` link tells us the TikTok Shop is almost certainly `MY`. Pass a region hint from the job's other URLs into the provider before it starts probing.
- [ ] **Add templates.** Only `nexova-starter` exists; the engine and UI are built for ten. Start with three that cover the target merchants: beauty and skincare, food and drink, fashion. Follow `docs/TEMPLATE_CONTRACT.md`. This is the largest item on the list.
- [x] **Buy button for TikTok Shop products.** Checkout falls back to the marketplace shop URL when there is no WhatsApp number or checkout link.
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
