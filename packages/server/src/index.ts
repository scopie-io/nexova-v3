/**
 * Nexova server: JSON API + SSE job progress + static hosting for generated stores and the web app.
 *
 *   POST /api/jobs                  { input, options }        -> job
 *   GET  /api/jobs/:id              -> job
 *   GET  /api/jobs/:id/events       -> SSE stream of JobEvents (replays history first)
 *   POST /api/jobs/:id/cancel
 *   GET  /api/jobs/:id/artifacts/:name
 *   GET  /api/stores                -> store list
 *   GET  /api/stores/:slug          -> { meta, spec }
 *   PUT  /api/stores/:slug/spec     -> replace spec (validated)
 *   PATCH/POST/DELETE /api/stores/:slug/products[/:id]  -> inventory edits (CMS seam)
 *   POST /api/stores/:slug/rebuild  -> rebuild job
 *   GET  /api/templates, /api/usage, /api/health
 *   GET  /s/:slug/*                 -> live store (static)
 *   GET  /*                         -> web app (packages/web/dist) when built
 */
import path from "node:path";
import { promises as fs } from "node:fs";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { streamSSE } from "hono/streaming";
import { Engine, loadDotEnv, liveDirFor, parseStoreSpec, type IncomingFile, type JobEvent, type JobOptions } from "@nexova/engine";

const here = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(here, "..", "..", "..");
await loadDotEnv(rootDir);

const engine = await Engine.create({ rootDir });
const app = new Hono();
app.use("/api/*", cors());

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
  ".map": "application/json",
  ".webmanifest": "application/manifest+json",
};

async function sendFile(root: string, rel: string, spaFallback = true): Promise<Response | null> {
  const safe = path.normalize(rel).replace(/^(\.\.[/\\])+/, "");
  let file = path.join(root, safe);
  if (!file.startsWith(root)) return null;
  try {
    const st = await fs.stat(file);
    if (st.isDirectory()) file = path.join(file, "index.html");
  } catch {
    if (!spaFallback) return null;
    file = path.join(root, "index.html");
  }
  try {
    const data = await fs.readFile(file);
    const ext = path.extname(file).toLowerCase();
    const headers: Record<string, string> = { "content-type": MIME[ext] ?? "application/octet-stream" };
    headers["cache-control"] = /\/assets\//.test(file.replace(/\\/g, "/")) ? "public, max-age=31536000, immutable" : "no-cache";
    return new Response(new Uint8Array(data), { status: 200, headers });
  } catch {
    return null;
  }
}

// ---------- API ----------

app.get("/api/health", async (c) => {
  const templates = await engine.templates();
  return c.json({ ok: true, model: engine.config.model, effort: engine.config.effort, offline: engine.config.offline, gateway: engine.gateway.id, deployer: engine.deployer.id, templates: templates.map((t) => t.manifest.id), publicUrl: engine.config.publicUrl, tiktokShopApi: !!engine.config.rapidApiKey });
});

app.get("/api/templates", async (c) => {
  const list = await engine.templates();
  return c.json(list.map((t) => t.manifest));
});

app.post("/api/jobs", async (c) => {
  const contentType = c.req.header("content-type") ?? "";
  let input = "";
  let options: JobOptions = {};
  const files: IncomingFile[] = [];
  if (contentType.includes("multipart/form-data")) {
    const body = await c.req.parseBody({ all: true });
    input = typeof body.input === "string" ? body.input : "";
    try {
      options = sanitizeOptions(typeof body.options === "string" ? (JSON.parse(body.options) as JobOptions) : undefined);
    } catch {
      options = {};
    }
    const raw = body.files ?? body["files[]"];
    const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
    for (const f of list) {
      if (typeof f === "string" || !(f instanceof File)) continue;
      if (f.size === 0 || f.size > 20 * 1024 * 1024) continue;
      files.push({ name: f.name, mime: f.type, data: Buffer.from(await f.arrayBuffer()) });
      if (files.length >= 30) break;
    }
  } else {
    const body = (await c.req.json().catch(() => ({}))) as { input?: string; options?: JobOptions };
    input = (body.input ?? "").toString();
    options = sanitizeOptions(body.options);
  }
  if (!input.trim() && files.length === 0) return c.json({ error: "Paste at least one link or product line, or attach screenshots." }, 400);
  const job = await engine.createStore(input, options, files);
  return c.json(job, 201);
});

app.get("/api/jobs/:id/coverage", async (c) => {
  const job = await engine.getJob(c.req.param("id"));
  if (!job) return c.json({ error: "not found" }, 404);
  const data = await engine.jobs.getArtifact(job, "coverage");
  return data ? c.json(data) : c.json({ error: "not ready" }, 404);
});

app.get("/api/jobs", async (c) => c.json(await engine.listJobs(Number(c.req.query("limit") ?? 30))));

app.get("/api/jobs/:id", async (c) => {
  const job = await engine.getJob(c.req.param("id"));
  return job ? c.json(job) : c.json({ error: "not found" }, 404);
});

app.post("/api/jobs/:id/cancel", async (c) => c.json({ cancelled: engine.cancel(c.req.param("id")) }));

app.get("/api/jobs/:id/artifacts/:name", async (c) => {
  const job = await engine.getJob(c.req.param("id"));
  if (!job) return c.json({ error: "not found" }, 404);
  const data = await engine.jobs.getArtifact(job, c.req.param("name"));
  if (data == null) return c.json({ error: "artifact not found" }, 404);
  return typeof data === "string" ? c.text(data) : c.json(data);
});

app.get("/api/jobs/:id/events", async (c) => {
  const id = c.req.param("id");
  const job = await engine.getJob(id);
  if (!job) return c.json({ error: "not found" }, 404);
  return streamSSE(c, async (stream) => {
    let seq = 0;
    const send = (e: JobEvent) => stream.writeSSE({ event: e.type, data: JSON.stringify(e), id: String(seq++) });
    for (const e of engine.bus.replay(id)) await send(e);
    if (!engine.isRunning(id)) {
      const latest = await engine.getJob(id);
      if (latest) await send({ type: "done", jobId: id, job: latest, at: new Date().toISOString() });
      return;
    }
    let closed = false;
    const queue: JobEvent[] = [];
    let wake: (() => void) | null = null;
    const unsubscribe = engine.subscribe(id, (e) => {
      queue.push(e);
      wake?.();
    });
    stream.onAbort(() => {
      closed = true;
      unsubscribe();
      wake?.();
    });
    const heartbeat = setInterval(() => void stream.writeSSE({ event: "ping", data: "" }), 15_000);
    try {
      while (!closed) {
        if (queue.length === 0) await new Promise<void>((r) => (wake = r));
        wake = null;
        while (queue.length) {
          const e = queue.shift()!;
          await send(e);
          if (e.type === "done" || (e.type === "status" && (e.status === "failed" || e.status === "cancelled"))) closed = true;
        }
      }
    } finally {
      clearInterval(heartbeat);
      unsubscribe();
    }
  });
});

app.get("/api/stores", async (c) => c.json(await engine.stores.list()));

app.get("/api/stores/:slug", async (c) => {
  const slug = c.req.param("slug");
  const spec = await engine.stores.getSpec(slug);
  if (!spec) return c.json({ error: "not found" }, 404);
  return c.json({ meta: await engine.stores.getMeta(slug), spec });
});

app.put("/api/stores/:slug/spec", async (c) => {
  const slug = c.req.param("slug");
  if (!(await engine.stores.exists(slug))) return c.json({ error: "not found" }, 404);
  try {
    const spec = parseStoreSpec(await c.req.json());
    if (spec.slug !== slug) return c.json({ error: "slug mismatch" }, 400);
    await engine.stores.saveSpec(spec);
    return c.json(spec);
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
  }
});

app.patch("/api/stores/:slug/products/:id", async (c) => {
  try {
    return c.json(await engine.stores.patchProduct(c.req.param("slug"), c.req.param("id"), await c.req.json()));
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
  }
});

app.post("/api/stores/:slug/products", async (c) => {
  try {
    return c.json(await engine.stores.upsertProduct(c.req.param("slug"), await c.req.json()));
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
  }
});

app.delete("/api/stores/:slug/products/:id", async (c) => {
  try {
    return c.json(await engine.stores.removeProduct(c.req.param("slug"), c.req.param("id")));
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
  }
});

app.post("/api/stores/:slug/rebuild", async (c) => {
  const slug = c.req.param("slug");
  if (!(await engine.stores.exists(slug))) return c.json({ error: "not found" }, 404);
  const body = (await c.req.json().catch(() => ({}))) as { templateId?: string | null };
  const job = await engine.rebuildStore(slug, { templateId: body.templateId ?? null });
  return c.json(job, 201);
});

app.get("/api/usage", async (c) => {
  const days = Number(c.req.query("days") ?? "0");
  const jobId = c.req.query("job") ?? undefined;
  return c.json(await engine.usage({ jobId, since: days > 0 ? new Date(Date.now() - days * 86_400_000) : undefined }));
});

// ---------- static: live stores ----------

app.get("/s/:slug", (c) => c.redirect(`/s/${c.req.param("slug")}/`));
app.get("/s/:slug/*", async (c) => {
  const slug = c.req.param("slug");
  if (!/^[a-z0-9-]+$/.test(slug)) return c.text("not found", 404);
  const root = liveDirFor(engine.config, slug);
  const rel = decodeURIComponent(c.req.path.replace(`/s/${slug}/`, "")) || "index.html";
  const res = await sendFile(root, rel);
  return res ?? c.text(`Store "${slug}" is not published yet.`, 404);
});

// ---------- static: web app ----------

const webDist = path.join(rootDir, "packages", "web", "dist");
app.get("/*", async (c) => {
  const rel = decodeURIComponent(c.req.path.replace(/^\//, "")) || "index.html";
  const res = await sendFile(webDist, rel);
  if (res) return res;
  return c.html(`<!doctype html><meta charset="utf-8"><title>Nexova</title><body style="font-family:system-ui;padding:40px;max-width:720px"><h1>Nexova API is running</h1><p>The web app is not built yet. Run <code>npm run build -w @nexova/web</code>, or start the web dev server with <code>npm run dev -w @nexova/web</code>.</p><p>API: <a href="/api/health">/api/health</a></p></body>`);
});

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
  console.log(`  Templates             ${(await engine.templates()).map((t) => t.manifest.id).join(", ") || "none installed"}`);
  if (stores.length) {
    console.log(`  Your stores`);
    for (const s of stores.slice(0, 8)) console.log(`    http://localhost:${info.port}/s/${s.slug}/`.padEnd(46) + `${s.products} products`);
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

function sanitizeOptions(o: JobOptions | undefined): JobOptions {
  if (!o || typeof o !== "object") return {};
  return {
    templateId: typeof o.templateId === "string" && o.templateId ? o.templateId : null,
    skipBuild: !!o.skipBuild,
    skipResearch: !!o.skipResearch,
    skipDiscovery: !!o.skipDiscovery,
    slug: typeof o.slug === "string" && /^[a-z0-9-]{2,60}$/.test(o.slug) ? o.slug : null,
    currency: typeof o.currency === "string" && /^[A-Za-z]{3}$/.test(o.currency) ? o.currency.toUpperCase() : null,
    instructions: typeof o.instructions === "string" ? o.instructions.slice(0, 2000) : null,
  };
}
