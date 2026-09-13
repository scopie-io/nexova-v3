import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Storefronts are cached per store and invalidated by tag when a merchant edits (Phase 2), so the
  // app is built on Cache Components from the start.
  cacheComponents: true,
  // Workspace packages ship TypeScript source.
  transpilePackages: ["@nexova/db"],
};

export default nextConfig;
