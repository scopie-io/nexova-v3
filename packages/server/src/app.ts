/**
 * The Nexova HTTP API as a Hono app, independent of how it is hosted.
 *
 *   POST /api/jobs                   -> create a build job (json {input, options} or multipart with files)
 *   GET  /api/jobs/:id               -> job record
 *   GET  /api/jobs/:id/events        -> SSE progress (status, step, log, usage, progress, done, error)
 *   POST /api/jobs/:id/cancel
 *   GET  /api/jobs/:id/coverage, /api/jobs/:id/artifacts/:name
 *   GET  /api/stores, /api/stores/:slug ; PUT /api/stores/:slug/spec
 *   PATCH/POST/DELETE /api/stores/:slug/products[/:id]  -> inventory edits (CMS seam)
 *   POST /api/stores/:slug/rebuild
 *   GET  /api/templates, /api/usage, /api/health
 *   GET  /s/:slug/*                  -> live store: served from disk locally, redirected to its host otherwise
 *   GET  /*                          -> web app when a dist folder is given (local); the host serves it otherwise
 *
 * Jobs run through a JobLauncher: in-process on the local server, as Workflow runs on Vercel.
 */
import path from "node:path";
import { promises as fs } from "node:fs";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { streamSSE } from "hono/streaming";
import { appDeepLinkToWeb, liveDirFor, parseStoreSpec, type Engine, type IncomingFile, type JobEvent, type JobOptions, type JobRecord } from "@nexova/engine";

export interface JobLauncher {
  id: string;
  create(raw: string, options: JobOptions, files: IncomingFile[]): Promise<JobRecord>;
  rebuild(slug: string, options: JobOptions): Promise<JobRecord>;
  /** Events from `startIndex` (0 = everything so far), then live events until the job reaches a terminal state. */
  events(job: JobRecord, signal: AbortSignal, startIndex: number): AsyncIterable<JobEvent>;
  cancel(jobId: string): Promise<boolean>;
}

export interface AppOptions {
  engine: Engine;
  launcher: JobLauncher;
  /** Serve the built web app from this folder (local server). Omit when the host serves static files. */
  webDist?: string | null;
  /** Serve published stores from disk under /s/<slug>/ (local deployer only). */
  serveStores?: boolean;
}

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

export function sanitizeOptions(o: JobOptions | undefined): JobOptions {
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

export function isTerminal(e: JobEvent): boolean {
  return e.type === "done" || (e.type === "status" && (e.status === "failed" || e.status === "cancelled" || e.status === "done"));
}

/** Runs jobs inside this process (local server, tests). */
export function inProcessLauncher(engine: Engine): JobLauncher {
  return {
    id: "in-process",
    create: (raw, options, files) => engine.createStore(raw, options, files),
    rebuild: (slug, options) => engine.rebuildStore(slug, options),
    cancel: async (jobId) => engine.cancel(jobId),
    async *events(job, signal, startIndex) {
      for (const e of engine.bus.replay(job.id).slice(startIndex)) yield e;
      if (!engine.isRunning(job.id)) {
        const latest = await engine.getJob(job.id);
        if (latest) yield { type: "done", jobId: job.id, job: latest, at: new Date().toISOString() };
        return;
      }
      const queue: JobEvent[] = [];
      let wake: (() => void) | null = null;
      const unsubscribe = engine.subscribe(job.id, (e) => {
        queue.push(e);
        wake?.();
      });
      signal.addEventListener("abort", () => wake?.(), { once: true });
      try {
        while (!signal.aborted) {
          if (queue.length === 0) await new Promise<void>((r) => (wake = r));
          wake = null;
          while (queue.length) {
            const e = queue.shift()!;
            yield e;
            if (isTerminal(e) && e.type === "done") return;
            if (e.type === "status" && (e.status === "failed" || e.status === "cancelled")) return;
          }
        }
      } finally {
        unsubscribe();
      }
    },
  };
}

export function createApp(opts: AppOptions): Hono {
  const { engine, launcher } = opts;
  const app = new Hono();
  app.use("/api/*", cors());

  app.get("/api/health", async (c) => {
    const templates = await engine.templates();
    const publisher = engine.deployer.check ? await engine.deployer.check().catch((err: unknown) => ({ ok: false, detail: err instanceof Error ? err.message : String(err) })) : { ok: true, detail: engine.deployer.id };
    return c.json({ ok: true, model: engine.config.model, effort: engine.config.effort, offline: engine.config.offline, gateway: engine.gateway.id, deployer: engine.deployer.id, publisher, storage: engine.storage.id, runner: launcher.id, templates: templates.map((t) => t.manifest.id), publicUrl: engine.config.publicUrl, tiktokShopApi: !!engine.config.rapidApiKey });
  });

  /** Support tool: what does this host see when it resolves a TikTok link? Limited to tiktok.com hosts (no open proxy). */
  app.get("/api/diag/resolve", async (c) => {
    const raw = c.req.query("url") ?? "";
    let target: URL;
    try {
      target = new URL(raw);
    } catch {
      return c.json({ error: "url required" }, 400);
    }
    if (!/(^|\.)tiktok\.com$/i.test(target.hostname)) return c.json({ error: "only tiktok.com links" }, 400);
    const startedAt = Date.now();
    try {
      const res = await fetch(target.toString(), { method: "GET", redirect: "manual", signal: AbortSignal.timeout(10_000), headers: { "user-agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1" } });
      const location = res.headers.get("location");
      return c.json({ status: res.status, location: location ? location.slice(0, 300) : null, web: location ? (location.startsWith("http") ? location.split("?")[0] : appDeepLinkToWeb(location)) : null, ms: Date.now() - startedAt });
    } catch (err) {
      const cause = (err as { cause?: { code?: string; message?: string } }).cause;
      return c.json({ error: err instanceof Error ? err.message : String(err), cause: cause ? `${cause.code ?? ""} ${cause.message ?? ""}`.trim() : null, ms: Date.now() - startedAt }, 502);
    }
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
    const job = await launcher.create(input, options, files);
    return c.json(job, 201);
  });

  app.get("/api/jobs/:id/coverage", async (c) => {
    const job = await engine.getJob(c.req.param("id"));
    if (!job) return c.json({ error: "not found" }, 404);
    const coverage = await engine.jobs.getArtifact(job, "coverage");
    if (!coverage) return c.json({ error: "coverage not available yet" }, 404);
    return c.json(coverage);
  });

  app.get("/api/jobs", async (c) => c.json(await engine.listJobs(Number(c.req.query("limit") ?? 30))));

  app.get("/api/jobs/:id", async (c) => {
    const job = await engine.getJob(c.req.param("id"));
    if (!job) return c.json({ error: "not found" }, 404);
    return c.json(job);
  });

  app.post("/api/jobs/:id/cancel", async (c) => c.json({ cancelled: await launcher.cancel(c.req.param("id")) }));

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
    // EventSource reconnects with Last-Event-ID after a timeout (hosted functions cap long streams);
    // resume from the next event instead of replaying the whole run.
    const last = Number.parseInt(c.req.header("last-event-id") ?? "", 10);
    const startIndex = Number.isFinite(last) && last >= 0 ? last + 1 : 0;
    return streamSSE(c, async (stream) => {
      let seq = startIndex;
      const abort = new AbortController();
      stream.onAbort(() => abort.abort());
      const heartbeat = setInterval(() => void stream.writeSSE({ event: "ping", data: "" }), 15_000);
      try {
        for await (const e of launcher.events(job, abort.signal, startIndex)) {
          await stream.writeSSE({ event: e.type, data: JSON.stringify(e), id: String(seq++) });
          if (abort.signal.aborted) break;
        }
      } finally {
        clearInterval(heartbeat);
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
    const job = await launcher.rebuild(slug, { templateId: body.templateId ?? null });
    return c.json(job, 201);
  });

  app.get("/api/usage", async (c) => {
    const days = Number(c.req.query("days") ?? "0");
    const jobId = c.req.query("job") ?? undefined;
    return c.json(await engine.usage({ jobId, since: days > 0 ? new Date(Date.now() - days * 86_400_000) : undefined }));
  });

  // ---------- live stores ----------

  app.get("/s/:slug", (c) => c.redirect(`/s/${c.req.param("slug")}/`));
  app.get("/s/:slug/*", async (c) => {
    const slug = c.req.param("slug");
    if (!/^[a-z0-9-]+$/.test(slug)) return c.text("not found", 404);
    if (opts.serveStores) {
      const root = liveDirFor(engine.config, slug);
      const rel = decodeURIComponent(c.req.path.replace(`/s/${slug}/`, "")) || "index.html";
      const res = await sendFile(root, rel);
      if (res) return res;
    }
    const meta = await engine.stores.getMeta(slug);
    if (meta?.siteUrl && !meta.siteUrl.includes(`/s/${slug}/`)) return c.redirect(meta.siteUrl);
    return c.text(`Store "${slug}" is not published yet.`, 404);
  });

  // ---------- web app ----------

  if (opts.webDist) {
    const webDist = opts.webDist;
    app.get("/*", async (c) => {
      const rel = decodeURIComponent(c.req.path.replace(/^\//, "")) || "index.html";
      const res = await sendFile(webDist, rel);
      if (res) return res;
      return c.html(`<!doctype html><meta charset="utf-8"><title>Nexova</title><body style="font-family:system-ui;padding:40px;max-width:720px"><h1>Nexova API is running</h1><p>The web app is not built yet. Run <code>npm run build -w @nexova/web</code>, or start the web dev server with <code>npm run dev -w @nexova/web</code>.</p><p>API: <a href="/api/health">/api/health</a></p></body>`);
    });
  } else {
    // The host serves the web app's files; anything else that is not an API route goes home.
    app.get("/*", (c) => (c.req.path.startsWith("/api/") ? c.json({ error: "not found" }, 404) : c.redirect("/")));
  }

  return app;
}
