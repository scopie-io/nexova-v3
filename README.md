# Nexova

Paste your social media links or your products. Get a live e-commerce website right away. Adjust inventory and everything else later.

Nexova reads a merchant's **TikTok Shop, Instagram, Shopee, Facebook, Lazada, Shopify or any website** (or a pasted product list), uses **Claude** to research the brand and normalize everything into one canonical `StoreSpec`, picks one of the React templates in `templates/`, and builds + publishes the storefront.

```
links / text ─▶ detect ─▶ ingest ─▶ research (Claude + web) ─▶ normalize (Claude, structured output)
            ─▶ assets ─▶ enrich (Claude + vision) ─▶ template ─▶ compose ─▶ build ─▶ deploy ─▶ live URL
```

## Running it

**Windows: double-click `start.cmd`.** It installs anything missing, builds, checks your Claude key, opens the browser and serves everything on one port.

Or from a terminal:

```bash
npm install          # first time only
npm run serve        # build everything, then start on http://localhost:4000
```

Once built, `npm start` alone is enough. One process serves three things:

| URL | What |
|---|---|
| `http://localhost:4000` | The Nexova app (paste links, watch the build) |
| `http://localhost:4000/s/<slug>/` | Every store you generate |
| `http://localhost:4000/api/...` | The JSON API (`/api/health`, `/api/stores`, `/api/usage`) |

Stop it with Ctrl+C. Your stores live in `stores/` and survive restarts.

**Start it automatically when you log in:** run `install-autostart.cmd` once (undo with `uninstall-autostart.cmd`).

**Use a different port:** `set PORT=4100 && npm start`.

**Preview a store on your phone:** the server listens on this PC only by default. To reach it from a phone on the same Wi-Fi, start with `set NEXOVA_HOST=0.0.0.0 && npm start`, then browse to `http://<this-pc-ip>:4000` (find the IP with `ipconfig`). This exposes Nexova to your local network, not to the internet.

Your Anthropic key lives in `.env`, which is gitignored. Without it the engine still runs, but in offline heuristic mode: no web research, no screenshot reading, and weaker copy.

Open http://localhost:4000, paste links, drop in screenshots of your shop pages (drag & drop, click, or Ctrl+V), click **Build my store**. The store is published at `http://localhost:4000/s/<slug>/`. A coverage report tells you what was read from each channel and what would make it more accurate.

CLI (same engine):

```bash
node packages/engine/dist/cli.js doctor --schemas                                                  # verify API key, model access, templates, and that every schema compiles
node packages/engine/dist/cli.js create "https://www.tiktok.com/@brand" "https://shopee.com.my/brand" --attach shop.png --attach products.csv
node packages/engine/dist/cli.js probe "https://shopee.com.my/brand" "https://www.instagram.com/brand/"   # ingestion only + coverage report
node packages/engine/dist/cli.js create "Matcha Latte Kit - RM 45" "Ceramic Mug RM58" --slug my-shop --offline
node packages/engine/dist/cli.js templates
node packages/engine/dist/cli.js stores
node packages/engine/dist/cli.js rebuild my-shop --template nexova-starter
node packages/engine/dist/cli.js usage --days 7
```

Capture a page yourself (useful for shops that block automated reading, needs `npm i -D playwright && npx playwright install chromium`):

```bash
node scripts/capture.mjs "https://shopee.com.my/yourshop" shot.png
```

## Repository layout

| Path | What |
|---|---|
| `packages/engine` | `@nexova/engine`: the whole pipeline, Claude gateway, template registry, generators, job store, usage ledger, CLI |
| `packages/server` | Hono HTTP API + SSE progress + static hosting of live stores and the web app |
| `packages/web` | The Nexova web app (paste links → watch the build → open the live store) |
| `templates/` | React storefront templates. Drop the 10 templates here; each needs `nexova.template.json` (see `docs/TEMPLATE_CONTRACT.md`). `nexova-starter` is the reference implementation |
| `stores/<slug>/` | Generated stores: `store.json` (source of truth), `assets/`, `site/` (composed source), `live/` (published build) |
| `data/` | Jobs and artifacts (`data/jobs/<id>/`), source cache, `usage/ledger.jsonl` |
| `docs/` | `ARCHITECTURE.md`, `INGESTION.md` (the strategy ladder: fetch ladder, platform APIs, readers, Wayback, browser, discovery, screenshots, merge, coverage), `TEMPLATE_CONTRACT.md` |

## Configuration (`.env`)

| Variable | Default | Meaning |
|---|---|---|
| `ANTHROPIC_API_KEY` | – | Required for Claude. Without it: offline mode (heuristics only) |
| `NEXOVA_MODEL` | `claude-opus-5` | Model for research / normalization / enrichment |
| `NEXOVA_EFFORT` | `high` | `low` … `max`; controls thinking depth and cost |
| `NEXOVA_FALLBACKS` | `default` | Server-side refusal fallback: `default`, a model id, or `off` |
| `NEXOVA_MAX_PRODUCTS` | `60` | Cap on products per store |
| `NEXOVA_CACHE_TTL_HOURS` | `24` | Source extraction cache |
| `NEXOVA_BROWSER` | `0` | `1` enables the optional Playwright provider (`npm i playwright`) |
| `NEXOVA_READER` | `auto` | Rendered-page reader for bot-blocked pages: `auto` / `off` / `jina` / `firecrawl` / `proxy` (see `docs/INGESTION.md`) |
| `NEXOVA_DISCOVERY` | `1` | Follow bio links / on-page links to find the merchant's other channels; `NEXOVA_SEARCH_DISCOVERY` adds a `site:` web search |
| `NEXOVA_DEPLOY_TARGET` | `local` | `local` (served by the Nexova server) or `netlify` (needs `NETLIFY_AUTH_TOKEN`) |
| `NEXOVA_PUBLIC_URL` | `http://localhost:4000` | Base of the live store URLs |

## Usage & cost

Every Claude call is appended to `data/usage/ledger.jsonl` with tokens, cache hits, web searches and an estimated USD cost. See `GET /api/usage?days=7`, `GET /api/usage?job=<id>`, or `nexova usage`.

## Tests

```bash
npm test          # unit tests + an offline end-to-end build with the starter template
```
