# Nexova template contract

A template is a standalone React (Vite) app in `templates/<id>/` that renders a `StoreSpec`. The engine copies the template, writes the store data + theme, builds it and publishes the output. Ten templates can coexist; the engine (Claude, or rules when offline) picks one per store, and a store can be re-rendered with another template at any time.

## Required files

```
templates/<id>/
  nexova.template.json     manifest (below)
  package.json             must provide the build script named in the manifest (default: npm run build)
  src/nexova/store.json    the StoreSpec the engine overwrites at compose time (ship a sample)
  src/nexova/theme.css     CSS variables the engine overwrites at compose time (ship a default)
  public/                  static dir; the engine copies downloaded images to public/nexova/images/
```

## Manifest: `nexova.template.json`

```json
{
  "id": "aurora-fashion",
  "name": "Aurora",
  "version": "1.0.0",
  "description": "Editorial fashion storefront with large imagery and lookbook grid.",
  "style": { "tags": ["editorial", "luxe", "minimal"], "mode": "both", "preset": "editorial" },
  "industries": ["fashion", "beauty", "accessories"],
  "features": { "variants": true, "collections": true, "reviews": true, "blog": false, "search": true, "cart": true, "whatsappCheckout": true },
  "entry": { "dataFile": "src/nexova/store.json", "themeFile": "src/nexova/theme.css", "publicDir": "public" },
  "build": { "install": "npm install --no-audit --no-fund", "build": "npm run build", "outDir": "dist", "dev": "npm run dev", "basePathEnv": "NEXOVA_BASE_PATH" },
  "preview": null,
  "minProducts": 1,
  "maxProducts": null
}
```

* `id` is kebab-case and unique. `style.tags`, `style.preset` (one of `clean, bold, editorial, playful, luxe, minimal, organic, tech`), `industries` (or `["any"]`) drive template selection.
* Everything except `id` and `name` has defaults.

## Runtime rules

1. **Read the store from `src/nexova/store.json`** (`import store from "./nexova/store.json"`). Do not fetch it. The starter template ships `src/nexova/types.ts` you can copy for typing.
2. **Base path**: read `process.env.NEXOVA_BASE_PATH` in `vite.config.ts` and pass it as `base`. Stores are served at `/s/<slug>/`, so all links and assets must be relative to `import.meta.env.BASE_URL`.
3. **Images**: an image `url` is either an absolute `http(s)` URL (keep as is) or a site-relative path such as `nexova/images/x.jpg` (prefix with `BASE_URL`). Use a placeholder when `images` is empty.
4. **Theme**: consume the CSS variables written to `src/nexova/theme.css`: `--nx-primary, --nx-secondary, --nx-accent, --nx-bg, --nx-surface, --nx-text, --nx-muted, --nx-font-heading, --nx-font-body, --nx-radius, --nx-preset`. The file also `@import`s the Google Fonts for `theme.fonts`.
5. **Routing**: use hash routing or generate a static `index.html` fallback; the server serves `index.html` for unknown paths under the store, but hash routing is the safest.
6. **Checkout**: honor `commerce.checkout.mode`:
   * `whatsapp` → open `https://wa.me/<whatsappNumber>?text=<order summary>`
   * `external_link` → send the buyer to `commerce.checkout.externalUrl` or the product's `source.url`
   * `none` → show contact info
7. **Render what exists**: `pages.home.sections` is the ordered list of homepage sections (`usp, featured, categories, story, testimonials, faq, newsletter, socials`). Skip sections with no data. Respect `product.visible`, `inventory.status`, `compareAtPrice`, `options`/`variants`.
8. **SEO**: put `seo.title` / `seo.description` into `<title>` / meta at build time (see the starter's `vite.config.ts` plugin).
9. **No network at build time** other than npm. No secrets.
10. **Dependencies** are installed once per template (`node_modules` is linked into every generated site), so keep the template self-contained and buildable with `npm install && npm run build` on a clean checkout.

## Check a template

```bash
node packages/engine/dist/cli.js templates                     # manifest is discovered and valid
node packages/engine/dist/cli.js create "Test Product - RM 10" --template <id> --offline --slug tpl-check
# open http://localhost:4000/s/tpl-check/
```
