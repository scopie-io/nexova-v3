import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": { target: "http://localhost:4000", changeOrigin: true },
      // regex, not a prefix: a plain "/s" also swallows /src/*, which blanks the dev server
      "^/s/": { target: "http://localhost:4000", changeOrigin: true },
    },
  },
  build: { outDir: "dist", emptyOutDir: true },
});
