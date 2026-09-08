/**
 * Local Nexova server: one Node process that runs jobs in-process, serves the API, the web app
 * and every published store. For Vercel, see nitro.ts (same app, Workflow-backed jobs).
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { Engine, loadDotEnv } from "@nexova/engine";
import { createApp, inProcessLauncher } from "./app.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(here, "..", "..", "..");
await loadDotEnv(rootDir, ".env.local");
await loadDotEnv(rootDir);

const engine = await Engine.create({ rootDir });
const app = createApp({ engine, launcher: inProcessLauncher(engine), webDist: path.join(rootDir, "packages", "web", "dist"), serveStores: engine.deployer.id === "local" });

const port = Number(process.env.PORT || 4000);
// Bound to this machine by default. Set NEXOVA_HOST=0.0.0.0 to also reach it from your phone
// or another device on the same Wi-Fi (using this PC's LAN IP).
const hostname = process.env.NEXOVA_HOST || "127.0.0.1";

const server = serve({ fetch: app.fetch, port, hostname }, async (info) => {
  const stores = await engine.stores.list().catch(() => []);
  // ASCII only: the Windows console defaults to a codepage that mangles box-drawing characters.
  const line = "-".repeat(58);
  console.log(`\n${line}`);
  console.log(`  Nexova is running at  http://localhost:${info.port}`);
  console.log(`  Claude                ${engine.config.offline ? "OFFLINE — no API key, heuristics only" : `${engine.config.model} (effort ${engine.config.effort})`}`);
  console.log(`  Storage               ${engine.storage.id === "vercel" ? "Neon + Blob" : "local disk"}`);
  console.log(`  Stores publish to     ${engine.deployer.id === "local" ? "this server" : engine.deployer.id}`);
  console.log(`  Templates             ${(await engine.templates()).map((t) => t.manifest.id).join(", ") || "none installed"}`);
  if (stores.length) {
    console.log(`  Your stores`);
    for (const s of stores.slice(0, 8)) console.log(`    ${(s.siteUrl ?? `http://localhost:${info.port}/s/${s.slug}/`).padEnd(46)} ${s.products} products`);
    if (stores.length > 8) console.log(`    ...and ${stores.length - 8} more`);
  }
  console.log(`\n  Stop with Ctrl+C`);
  console.log(`${line}\n`);
});

server.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EADDRINUSE") {
    console.error(`\nERROR:Port ${port} is already in use — Nexova may already be running.\n  Open http://localhost:${port} , or start on another port with:  set PORT=4100 && npm start\n`);
  } else if (err.code === "EACCES") {
    console.error(`\nERROR:Not allowed to use port ${port}. Try a port above 1024, e.g.  set PORT=4100 && npm start\n`);
  } else {
    console.error(`\nERROR:Server failed to start: ${err.message}\n`);
  }
  process.exit(1);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    console.log("\nNexova stopped.");
    process.exit(0);
  });
}
