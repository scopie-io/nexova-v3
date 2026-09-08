# Nexova — Product Requirements Document

| | |
|---|---|
| Version | 1.0 |
| Date | 2026-09-08 |
| Status | Draft for review |
| Owner | Ahmad Zafran (product, engineering) |

## 1. Summary

Nexova turns a merchant's existing social or marketplace presence into a standalone e-commerce website in minutes. The merchant pastes links (TikTok Shop first, then Shopee, Instagram, Facebook, Lazada, Shopify, or any website), optionally drops in screenshots or a product CSV, and clicks **Build my store**. Nexova reads the brand and catalog, uses Claude to research and normalize everything into one canonical store model, renders a React storefront from a template, and publishes it at a live URL with WhatsApp checkout. Inventory, copy, and design are adjustable afterwards.

The headline promise: **"The fastest way to launch your online store."**

## 2. Problem

Small merchants in Southeast Asia already sell through TikTok Shop, Shopee, Instagram, and WhatsApp. They lack a website of their own, which costs them:

- **Discoverability.** Marketplace and social listings are not indexed as a brand; there is nothing to link from a bio, a flyer, or an ad.
- **Ownership.** Platform fees, algorithm changes, and account bans can wipe out a channel overnight. The catalog and customer relationship live on rented land.
- **Effort.** Existing site builders assume the merchant will re-enter every product, photo, and price by hand and make design decisions they are not equipped to make. Most abandon the attempt.

The data already exists on the platforms. The missing piece is a tool that reads it and does the rest.

## 3. Goals and non-goals

### Goals

1. A TikTok Shop seller can paste one store link and receive a live, presentable storefront with their real products, prices, photos, and brand identity, with no other input.
2. Time from paste to live URL is under five minutes for a typical shop of up to 60 products.
3. Every generated store is honest about its sources: a coverage report says what was read from where, what is missing, and the single most useful thing the merchant can do to improve it.
4. The pipeline degrades gracefully. A blocked platform, a failed research step, or an exhausted API quota never sinks the build.
5. The store's data is a single editable file, so a later editing UI or CMS plugs in without re-architecting.

### Non-goals (this version)

- Native payments, carts with server-side checkout, or order management. Checkout is WhatsApp or a link back to the marketplace.
- Multi-user accounts, authentication, or billing for Nexova itself.
- Official platform integrations that require OAuth (TikTok Shop Partner API, Shopee Open Platform, Meta Commerce).
- Custom domains and production hosting beyond the local server and Netlify.
- A visual editor. Edits go through the JSON API and the rebuild command.

## 4. Users

**Primary: the solo merchant.** Sells on TikTok Shop and/or Shopee, runs the business from a phone, takes orders on WhatsApp. Not technical. Wants a website that looks professional and reflects what they already sell, without data entry. Malaysia first, then Singapore, Indonesia, Philippines, Thailand, Vietnam.

**Secondary: the operator.** The person running a Nexova instance for merchants: an agency, a reseller, or the founder. Configures API keys, watches build progress and cost, and drops in new templates.

## 5. User journey

1. Merchant opens Nexova and sees one input box with placeholder links.
2. Pastes their TikTok Shop store link. Optionally adds a Shopee or Instagram link, screenshots of their shop page, a CSV export, or free-text product lines like "Matcha Kit - RM 45".
3. Optionally opens **Options** to pick a template, force a currency, or add instructions.
4. Clicks **Build my store**. A progress view streams each pipeline step in plain language.
5. Gets a live URL under `/s/<slug>/`, a coverage report, and recommendations such as "add your WhatsApp number" or "attach screenshots of your Shopee product list".
6. Can switch template and rebuild in one click. Returns later to **Your stores** to reopen or rebuild any store.
7. Adjusts products, prices, or visibility through the store API, then rebuilds without re-running Claude.

## 6. Functional requirements

### 6.1 Input

- Accept any mix of URLs and free text in one textarea. Classify each URL by platform and kind (profile, shop, product, post) with region detection from the domain, path, or query string.
- Accept image attachments (PNG, JPG) via drag and drop, click, or paste, and CSV, JSON, or text files. Spreadsheet prices take precedence over anything scraped.
- Recognize TikTok Shop store links (`/shop/store/<slug>/<id>`), product links (`/view/product/<id>`, `shop.tiktok.com/<cc>/pdp/<id>`), TikTok profiles, Instagram, Facebook, Shopee, Lazada, Shopify, WhatsApp, and generic websites.

### 6.2 Ingestion

- Run a provider ladder per URL, cheapest first, and stop escalating once the source has enough (three or more products for a shop, an identity for a profile).
- **TikTok Shop API provider** (RapidAPI, requires `RAPIDAPI_KEY`): the primary source for TikTok Shop. A store link returns the paginated catalog and full details for the top products (description, all photos, variants, stock, reviews) plus the seller profile (name, avatar, followers, rating, location). A product link yields the product, its seller, and then the seller's catalog. A creator profile yields the showcase, flagged as possibly affiliate. Region is taken from the URL, then a configurable ordered list, and locked after the first hit. Every request costs one credit; page and detail counts are configurable, and a quota error stops the provider cleanly.
- Direct fetch with a user-agent ladder, parsing OpenGraph, JSON-LD, embedded framework state, readable text, images, links, and contacts.
- Platform endpoints: TikTok oEmbed, Instagram profile APIs, Shopee v4, Lazada ajax listings, Shopify `products.json`, Facebook Graph avatar.
- Fallbacks: rendered-page readers (Jina, Firecrawl, proxy), Wayback Machine, optional Playwright with full-page screenshots.
- One-hop discovery of the merchant's other channels via bio links, on-page links, and web search.
- Vision reading of screenshots and captures for shop names, handles, products, prices, and contacts.
- Merge products across sources with provenance precedence (CSV beats API beats scrape beats vision), dedupe, sanity-check prices and currency, and produce a coverage report with a score, gaps, and recommendations.
- Cache successful source reads for 24 hours. Never reuse blocked, failed, or empty results.

### 6.3 AI normalization and enrichment

- Research: Claude with web search and fetch tools writes a factual brand brief from a compact summary of what ingestion found and what is missing. Never fatal; degrades to skipped.
- Normalize: structured outputs turn signals plus brief into a `StoreDraft` (brand, theme, commerce, categories, copy) and product batches, then into the canonical `StoreSpec` with stable ids, currency, WhatsApp checkout, and socials.
- Enrich: with downloaded images in context, finalize copy, palette, fonts, section order, featured products, FAQ, SEO, and pick a template.
- Offline mode: with no API key the same pipeline runs on deterministic heuristics so the product is usable and testable without Claude.
- Record every model call in a usage ledger with tokens, cache hits, web searches, and estimated cost, exposed at `/api/usage`.

### 6.4 Generation and publishing

- Download brand and product images locally so stores do not depend on expiring social CDN links.
- Templates are standalone Vite React apps under `templates/<id>/` with a manifest declaring style, industries, features, and build commands. Ten templates can coexist; the engine picks one by Claude's choice, merchant override, or rule scoring.
- Compose: copy the template, write `store.json` and `theme.css`, copy assets. Build with a base path of `/s/<slug>/`. Deploy locally or to Netlify.
- One process serves the web app, the API, and every generated store.

### 6.5 Store management

- `stores/<slug>/store.json` is the source of truth. API endpoints update the spec, patch, add, or remove products, and trigger a rebuild without Claude.
- List, reopen, and rebuild stores from the web app. Switch template on rebuild.
- CLI parity: `create`, `probe`, `rebuild`, `stores`, `templates`, `usage`, `doctor`.

### 6.6 Operator experience

- `.env` configures the Claude model and effort, the TikTok Shop API key and credit budgets, readers, discovery, browser, deploy target, and limits.
- `doctor` verifies the key, model access, templates, schema compilation, and each optional provider's configuration.
- Health endpoint reports mode, gateway, templates, and whether the TikTok Shop API is enabled.
- Windows one-click start and autostart scripts; plain `npm run serve` elsewhere.

## 7. Non-functional requirements

| Area | Requirement |
|---|---|
| Reliability | Every pipeline step is idempotent, persisted, and Zod-validated. A source failure never fails a job. |
| Latency | Under five minutes paste-to-live for a 60-product shop with Claude online. Research capped by a configurable timeout. |
| Cost | Research runs at its own lower effort with a compact brief. Prompt caching on byte-stable system prompts. TikTok Shop API credits bounded per shop by config. All spend visible in the ledger. |
| Privacy | Merchant keys live in `.env`, gitignored. No merchant data leaves the machine except to Claude and the configured APIs. |
| Portability | Node 20+. Runs on a merchant's Windows PC, a Mac, or a Linux server. |
| Extensibility | New source, new deploy target, new template, or new model gateway each touch one interface. |

## 8. Success metrics

| Metric | Target |
|---|---|
| Paste-to-live time, TikTok Shop link only | under 5 minutes, p90 |
| Coverage score for a TikTok Shop link with the API enabled | 0.8 or higher |
| Products with price and photo, TikTok Shop source | 95 percent or higher |
| Jobs that end in a live store, any input | 99 percent |
| Claude cost per build | under USD 1.50 median |
| TikTok Shop API credits per build | under 10 with default settings |

## 9. Dependencies and risks

| Risk | Impact | Mitigation |
|---|---|---|
| RapidAPI TikTok Shop plan quota exhausted or provider disappears | TikTok Shop links fall back to scraping, which returns little | Quota error surfaces as a coverage gap with a clear operator action. Credits bounded per shop. Provider interface allows a second vendor or the official Partner API later. |
| Platforms tighten bot blocking | Fewer products from Shopee, Instagram, Facebook | Reader and browser fallbacks, screenshots plus vision, discovery of alternate channels. |
| Claude structured-output limits | Mid-job schema rejection | Draft schemas avoid nullable unions, use sentinels, and are tested for union count in CI. |
| Social CDN image links expire | Broken photos on live stores | Images downloaded at build time. |
| Only one template exists | Every store looks the same | Template contract is documented; nine more templates are the next content task. |
| Node version drift | Test runner warns on Node 20 | Pin Node 22 LTS in the next release. |

## 10. Release plan

**v0.2 (current):** end-to-end pipeline, TikTok Shop API provider, one template, local and Netlify deploy, coverage reports, usage ledger, CLI, web app.

**v0.3:** nine additional templates across fashion, beauty, food, home, and electronics. Node 22. Region inference from sibling links so TikTok Shop probing spends fewer credits. Testimonials rendered from TikTok Shop reviews.

**v0.4:** inventory and copy editor in the web app on top of the existing store API. Custom domains. Hosted deploy target beyond Netlify.

**v1.0:** merchant accounts, official TikTok Shop and Shopee connectors, native checkout with a regional payment provider, order notifications to WhatsApp.

## 11. Open questions

1. Default region order for TikTok Shop when the link does not say: Malaysia first matches the target market, but each miss costs a credit. Should the operator set it per instance, or should Nexova infer it from sibling links and text?
2. How many product details to fetch per shop by default. Six balances photos and variants against credits; merchants with large catalogs may want more.
3. Whether creator showcase products should appear in the store by default or only after the merchant confirms they are the seller.
4. Hosting model for merchants who do not run a PC: managed Nexova instance versus one-click deploy to their own Netlify or Vercel account.
