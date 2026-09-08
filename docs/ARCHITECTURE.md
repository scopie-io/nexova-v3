# Nexova engine architecture

## Goals

1. **Stable**: every step is idempotent, persisted, and validated with Zod at its boundary. A failure in one source (a blocked Instagram page) never sinks the job.
2. **Consistent**: one canonical data model (`StoreSpec`) between ingestion, Claude, templates and the future CMS. Templates never see raw scraped data.
3. **Strong extraction**: a layered ingestion strategy (direct HTML → platform APIs/oEmbed → optional headless browser → Claude web research) so the engine gets *everything possible* even when platforms block scrapers.

## The pipeline

```
detect     Split pasted input into classified URLs (platform, kind, handle, region, id) and text lines.
ingest     Run providers per URL (cheapest first): direct-fetch (OG, JSON-LD, readable text, images,
           embedded JSON such as TikTok __UNIVERSAL_DATA__), tiktok-oembed, instagram-profile-api,
           shopee-api (v4 shop detail / items), shopify-products-json (/products.json), facebook-mbasic,
           playwright (optional). Results are merged into SourceSignals and cached (data/cache/sources).
research   Claude with server-side web_search + web_fetch tools browses the merchant's links and the web,
           writes a factual brief (brand, products, prices, images, contact). Handles pause_turn.
normalize  Claude structured outputs: signals + brief -> StoreDraft (brand/theme/commerce/categories/copy)
           and ProductBatchDraft per batch of 20 raw candidates. mapping.ts turns drafts into a StoreSpec
           (stable ids/slugs, currency, WhatsApp checkout, socials).
assets     Download brand + product images into stores/<slug>/assets (social CDNs expire and block
           hotlinking). Spec image URLs become site-relative; failures keep the remote URL.
enrich     Claude (with the downloaded images) finalizes copy, palette, fonts, section order, featured
           products, FAQ, SEO and picks a template from the registry.
template   Resolve the template (requested > Claude's choice > rule scoring).
compose    Copy the template, link its node_modules, write src/nexova/store.json + theme.css, copy assets.
build      `npm run build` with NEXOVA_BASE_PATH=/s/<slug>/.
deploy     LocalDeployer (stores/<slug>/live, served by the server) or NetlifyDeployer.
```

Each step reports status + a human message through the `JobBus` (SSE in the server, `subscribe()` in the SDK). Artifacts (`input.json`, `ingest.json`, `research.md`, `store.draft.json`, `products.draft.json`, `spec.json`, `enrichment.json`) live in `data/jobs/<id>/`.

## Claude usage

* Model: `claude-opus-5` (configurable), adaptive thinking, `output_config.effort` from `NEXOVA_EFFORT`.
* Structured outputs (`betaZodOutputFormat`) for every normalization/enrichment call; schemas in `schema/drafts.ts` follow the structured-output rules (all fields required, nullable instead of optional, no maps, no recursion).
* Streaming (`client.beta.messages.stream(...).finalMessage()`) so long outputs never hit HTTP timeouts.
* Server-side refusal fallbacks are on by default (`fallbacks: "default"`); set `NEXOVA_FALLBACKS=off` to disable.
* Prompt caching: system prompts are byte-stable and carry `cache_control`; all per-job material lives in the user turn.
* Research uses `web_search_20260209` + `web_fetch_20260209` with `max_uses` caps; `pause_turn` is resumed up to 8 times.
* `claude/gateway.ts` is the only seam to the model. `OfflineGateway` implements the same interface with heuristics so the pipeline runs (and is tested) without a key.
* Every call is recorded in `UsageLedger` (tokens, cache read/write, web searches, estimated cost).

### Structured-output constraints the drafts are shaped around

* **At most 16 union-typed parameters per schema.** The API rejects anything wider with *"too many parameters with type arrays or anyOf"*, and it fails at call time, mid-job. Draft schemas therefore avoid `nullable()` entirely and express absence with sentinels: `""` for unknown text, `0` for an unknown count, `"keep"` for "do not change this". `claude/mapping.ts` converts sentinels back to real nulls (`text()` / `count()`), and `schema/drafts.test.ts` counts the unions in every generated JSON Schema so a regression fails in CI rather than in production.
* Every property is required (structured outputs do not allow optionals), which the same test asserts.
* Research runs at its own effort (`NEXOVA_RESEARCH_EFFORT`, default `medium`) and is fed a compact brief rather than the full scrape: it re-sends its transcript on every tool round, so a large prompt multiplies cost and latency across the whole browsing loop.
* Research is **never fatal**. A timeout, refusal or outage degrades the step to `skipped` and records a gap; the merchant still gets their store.

## Data model

`schema/store-spec.ts` (`StoreSpec`) is the contract. Highlights: `brand`, `theme` (preset, colors, fonts, radius), `social`, `catalog.products[]` (price, compareAt, images, options/variants, inventory, categories, rating, source, confidence, visible), `catalog.categories[]`, `pages` (home sections, USPs, about, FAQ, testimonials), `commerce` (currency, locale, checkout mode whatsapp / external_link / none, shipping, policies), `seo`, `template`, `sources`, `meta`.

The store's source of truth is `stores/<slug>/store.json`. `StoreRepository` exposes `updateSpec`, `patchProduct`, `upsertProduct`, `removeProduct` and the server exposes them under `/api/stores/:slug/...`; a `rebuild` recomposes, builds and redeploys without Claude. This is the seam the CMS/inventory UI plugs into later.

## Extending

* **New source platform**: add a `Provider` in `ingest/providers/` (supports + run), register in `ingest.ts`. Add URL classification in `ingest/detect.ts`.
* **New deploy target**: implement `Deployer` in `generate/deploy/` and select it in `Engine`.
* **New template**: a folder in `templates/` with `nexova.template.json` (see TEMPLATE_CONTRACT.md).
* **Different model/gateway**: implement `ClaudeGateway`.
