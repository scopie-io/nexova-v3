# How Nexova reads a shop

Merchants paste links, product lines and screenshots. Platforms block bots. This document is the strategy that makes ingestion **seamless but accurate**, modeled on the best current tooling (Firecrawl's fetch ladder and LLM extraction, Jina Reader's render-as-a-service, Crawl4AI's markdown-first parsing, Apify-style platform actors, Browserbase/Stagehand-style browsing) and on how social-commerce builders (Shopline, EasyStore, Linktree Shops, Shopify's importers) treat merchant-provided data as the source of truth.

## Inputs

| Input | What happens |
|---|---|
| Links (TikTok, TikTok Shop, Instagram, Facebook, Shopee, Lazada, Shopify, any website, bio-link pages) | Classified by platform/kind/handle/region, canonicalized, run through the provider ladder |
| Product lines (`Matcha Kit - RM 45 (100g)`) | Parsed locally; price + currency + description; authoritative over scraped values |
| Screenshots (PNG/JPG/WebP, one or many) | Sent to Claude vision in batches of 6; one structured extract per image (platform, page type, shop identity, products with prices/sold counts/variants, contacts) |
| CSV / TSV / JSON exports (Shopify, Shopee, WooCommerce, custom) | Parsed locally with header aliases (English + Malay), variant rows grouped; highest precedence |
| Free text (WhatsApp number, description) | Contact harvesting + copy input |

## The provider ladder (per link)

Cheapest first; expensive strategies run only while the source is still "thin" (no products for a shop, no identity for a profile).

1. **Source cache** (24h, never reuses blocked/failed results)
2. **direct-fetch** with a per-platform **user-agent ladder** (`googlebot → desktop → mobile` for Shopee/Lazada/TikTok Shop, `mobile → googlebot → desktop` for Instagram/Facebook). Parses OpenGraph, JSON-LD, readable text, images, links, TikTok `__UNIVERSAL_DATA__`, Instagram inline JSON, and runs the **embedded-JSON hunter** (Next/Nuxt state, `__MODERN_ROUTER_DATA__`, `app.run(...)`, `JSON.parse("...")` blobs) to pull product objects out of any framework payload. Harvests WhatsApp/mailto/tel contacts.
3. **Platform providers**: TikTok oEmbed; Instagram web + mobile-app profile endpoints (bio links, recent posts); Shopee `get_shop_detail` / `get_shop_base` / `pdp/get_pc` / `search_items` / `recommend`; Lazada `?ajax=true` listings + product JSON; Shopify `/products.json` (paginated) + `/meta.json` currency; Facebook Graph avatar + about page.
4. **Readers** (fallback): Firecrawl (`FIRECRAWL_API_KEY`, markdown + links + full-page screenshot), generic proxy template (`NEXOVA_PROXY_URL`, e.g. ScrapingBee/ScraperAPI), **Jina Reader** (default, keyless). Rendered markdown is mined for price lines, images, links and contacts.
5. **Wayback Machine** (fallback, blocked pages only): archived snapshot, products tagged as archived.
6. **Playwright** (opt-in `NEXOVA_BROWSER=1`): stealth-ish context, auto-scroll for lazy grids, hunter on the rendered DOM, **full-page screenshot fed to vision**.

Every attempt is recorded (`attempts[]`) and shows up in the coverage report.

## Discovery (one hop)

Bio websites, JSON-LD `sameAs`, on-page social links and oEmbed author URLs are collected. Bio-link pages (Linktree, Beacons, lynk.id, bio.site, Taplink, ... 35 hosts) are fetched and expanded, including links hidden in their JSON. Candidates are classified and ingested as `discovered` sources (capped by `NEXOVA_MAX_DISCOVERED`). When key marketplaces are still missing, a DuckDuckGo HTML search with `site:` filters runs and **only accepts results whose handle matches the merchant's** (strict identity check). Discovered sources are labeled for Claude to verify.

## Merge, sanity, coverage

All candidates (sources, attachments, pasted lines) are merged by external id, URL, or title similarity (token Jaccard ≥ 0.75 with a price-gap guard). Fields come from the highest-precedence source: CSV/JSON (100) > Shopify JSON (96) > Shopee/Lazada APIs (94) > JSON-LD (90) > embedded JSON (86) > browser (84) > pasted text (80) > Firecrawl/proxy (70) > Jina (62) > vision (58) > Wayback (40). Disagreements (price > 30% apart), outliers, missing prices/images and currency mismatches become `notes` that Claude sees and the merchant gets as warnings.

The **coverage report** (`data/jobs/<id>/coverage.json`, `GET /api/jobs/:id/coverage`, shown in the UI) lists each source with status/strategies, totals, gaps and concrete recommendations ("Shopee blocks automated reading. Attach 2–6 screenshots of your shop page and product list"). Score = identity 25% + products 35% + prices 15% + photos 15% + contact 10%.

## Preparing images for vision

A phone screenshot or a full-page browser capture is routinely 3–6MB and can be 1366×14000 pixels. Sending that raw fails the API size limit, and scaling it to fit makes every price unreadable. `ingest/images.ts` therefore:

1. Reads the image with sharp and measures its aspect ratio.
2. Splits anything taller than ~1.6× its width into up to 6 overlapping horizontal bands (8% overlap, so a product card cut by a boundary still appears whole in one band).
3. Resizes each band to 1568px on the long edge (the resolution Claude works at) and encodes JPEG, stepping quality down until it fits comfortably under the payload limit.

Parts of one screenshot are labelled "part n of k, scrolling down" and the model is told to merge them into a single item. Overlap still produces the occasional double reading, so the merge step breaks ties by completeness: the reading that captured both the sale price and the struck-through original wins, and that case is not reported as a price disagreement.

## Claude's role

- **Vision** (`ATTACHMENT_SYSTEM`): transcribes product cards exactly as displayed, marks unreadable items instead of guessing, infers currency from symbols/region.
- **Research** (web_search + web_fetch): receives the merged candidates, extracts and coverage gaps, and browses only what is missing; verifies discovered channels belong to the merchant.
- **Normalization**: consumes merged candidates with notes and evidence, resolves conflicts using the strongest evidence.

## Probe without building

```bash
node packages/engine/dist/cli.js probe "https://shopee.com.my/yourshop" "https://www.instagram.com/yourshop/" --attach shot1.png --attach shot2.png
```

Prints per-source status, strategies that worked, merged products with provenance, gaps and recommendations.

## Configuration

| Variable | Default | Effect |
|---|---|---|
| `NEXOVA_READER` | `auto` | `auto` / `off` / `jina` / `firecrawl` / `proxy` |
| `JINA_API_KEY` | – | Higher Jina rate limits |
| `FIRECRAWL_API_KEY` | – | Enables Firecrawl (markdown + screenshot) |
| `NEXOVA_PROXY_URL` | – | e.g. `https://app.scrapingbee.com/api/v1/?api_key=KEY&render_js=true&url={url}` |
| `NEXOVA_DISCOVERY` | `1` | Follow bio/on-page links |
| `NEXOVA_SEARCH_DISCOVERY` | `1` | DuckDuckGo `site:` search for missing channels |
| `NEXOVA_MAX_DISCOVERED` | `6` | Cap on discovered sources |
| `NEXOVA_WAYBACK` | `1` | Archived snapshot fallback |
| `NEXOVA_BROWSER` | `0` | Playwright provider |
| `NEXOVA_MAX_VISION_IMAGES` | `20` | Screenshots per job sent to vision |

## What still needs the merchant (and where official APIs come in)

Private accounts, login-walled Facebook pages and Shopee/TikTok Shop listings that never render to bots are covered by screenshots today. The accurate long-term path is the official platform APIs (TikTok Shop Partner API, Shopee Open Platform, Instagram Graph API, Meta Commerce) once merchants can connect accounts in the CMS phase; the provider interface is where those connectors plug in.
