import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { readFileSync } from "node:fs";

// Nexova template contract: the engine sets NEXOVA_BASE_PATH (e.g. "/s/my-shop/") at build time.
const base = process.env.NEXOVA_BASE_PATH || "/";

function nexovaHtml() {
  // Inject SEO title/description from the StoreSpec into index.html at build time.
  let title = "Store";
  let description = "";
  try {
    const spec = JSON.parse(readFileSync(new URL("./src/nexova/store.json", import.meta.url), "utf8"));
    title = spec.seo?.title || spec.brand?.name || title;
    description = spec.seo?.description || spec.brand?.description || "";
  } catch {
    /* keep defaults */
  }
  return {
    name: "nexova-html",
    transformIndexHtml(html: string) {
      return html.replace("<title>Store</title>", `<title>${escapeHtml(title)}</title>`).replace('<meta name="description" content="" />', `<meta name="description" content="${escapeHtml(description)}" />`);
    },
  };
}

function escapeHtml(s: string) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export default defineConfig({
  base,
  plugins: [react(), nexovaHtml()],
  build: { outDir: "dist", emptyOutDir: true, sourcemap: false },
});
