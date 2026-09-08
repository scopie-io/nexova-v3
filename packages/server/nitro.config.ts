import { defineConfig } from "nitro";

/**
 * Nitro builds the hosted server: the Hono API as a Vercel Function, the pipeline as Workflow
 * functions (workflow/nitro), and the web app as static assets. The Vercel project's root directory
 * is packages/server (see vercel.json there), so the Build Output lands in packages/server/.vercel/output.
 */
export default defineConfig({
  modules: ["workflow/nitro"],
  routes: {
    "/**": "./src/nitro.ts",
  },
  publicAssets: [{ dir: "../web/dist", baseURL: "/" }],
  compatibilityDate: "2026-09-01",
});
