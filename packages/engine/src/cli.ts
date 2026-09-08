#!/usr/bin/env node
/**
 * nexova CLI
 *   nexova create <link-or-text ...> [--attach shot.png ...] [--template id] [--skip-build] [--skip-research] [--skip-discovery] [--instructions "..."] [--currency MYR] [--slug my-shop]
 *   nexova rebuild <slug> [--template id]
 *   nexova templates
 *   nexova stores
 *   nexova usage [--job id] [--days 7]
 *   nexova job <id>
 *   nexova probe <link ...>            run ingestion only and print the coverage report
 *   nexova doctor                      verify the API key, model access and templates
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { Engine } from "./index.js";
import type { IncomingFile } from "./ingest/attachments.js";
import { detectInput } from "./ingest/detect.js";
import { ingest } from "./ingest/ingest.js";
import { loadDotEnv } from "./util/env.js";
import { createLogger, setLogLevel } from "./util/log.js";
import type { JobEvent } from "./schema/job.js";

type FlagValue = string | boolean | string[];

interface Args {
  cmd: string;
  positional: string[];
  flags: Record<string, FlagValue>;
}

function parseArgs(argv: string[]): Args {
  const [cmd = "help", ...rest] = argv;
  const positional: string[] = [];
  const flags: Record<string, FlagValue> = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = rest[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        const prev = flags[key];
        flags[key] = prev === undefined ? next : Array.isArray(prev) ? [...prev, next] : [String(prev), next];
        i++;
      } else flags[key] = true;
    } else positional.push(a);
  }
  return { cmd, positional, flags };
}

function str(v: FlagValue | undefined): string | null {
  return typeof v === "string" ? v : Array.isArray(v) ? v[v.length - 1] : null;
}

function list(v: FlagValue | undefined): string[] {
  return typeof v === "string" ? [v] : Array.isArray(v) ? v : [];
}

const MIME_BY_EXT: Record<string, string> = { ".png": "image/png", ".webp": "image/webp", ".gif": "image/gif", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".csv": "text/csv", ".tsv": "text/csv", ".json": "application/json", ".txt": "text/plain" };

async function readAttachments(paths: string[]): Promise<IncomingFile[]> {
  const out: IncomingFile[] = [];
  for (const p of paths) {
    const data = await fs.readFile(p);
    out.push({ name: path.basename(p), mime: MIME_BY_EXT[path.extname(p).toLowerCase()] ?? "application/octet-stream", data });
  }
  return out;
}

function printEvent(e: JobEvent): void {
  switch (e.type) {
    case "step":
      if (e.step.status === "running") process.stdout.write(`\n[${e.step.name}] …`);
      else process.stdout.write(`\r[${e.step.name}] ${e.step.status}${e.step.message ? ` — ${e.step.message}` : ""}`);
      break;
    case "progress":
      process.stdout.write(`\r  ${e.message.slice(0, 110).padEnd(110)}`);
      break;
    case "error":
      process.stdout.write(`\n✖ ${e.error}\n`);
      break;
    case "done":
      process.stdout.write(`\n\n✔ Done${e.job.siteUrl ? `: ${e.job.siteUrl}` : ""}\n  store: ${e.job.slug}\n  template: ${e.job.templateId}\n  cost: $${e.job.usage.costUsd.toFixed(4)} (${e.job.usage.calls} Claude calls, ${e.job.usage.webSearches} searches)\n`);
      break;
    default:
      break;
  }
}

async function main(): Promise<void> {
  await loadDotEnv();
  const args = parseArgs(process.argv.slice(2));
  if (args.flags.offline) process.env.NEXOVA_OFFLINE = "1";
  if (!args.flags.verbose && !process.env.NEXOVA_LOG_LEVEL) setLogLevel("warn");
  const engine = await Engine.create();

  switch (args.cmd) {
    case "create": {
      const raw = args.positional.join("\n");
      const files = await readAttachments(list(args.flags.attach));
      if (!raw.trim() && !files.length) throw new Error("nexova create <links or product lines> [--attach file ...]");
      const job = await engine.createStore(
        raw,
        {
          templateId: str(args.flags.template),
          skipBuild: !!args.flags["skip-build"],
          skipResearch: !!args.flags["skip-research"],
          skipDiscovery: !!args.flags["skip-discovery"],
          instructions: str(args.flags.instructions),
          currency: str(args.flags.currency),
          slug: str(args.flags.slug),
        },
        files,
      );
      console.log(`job ${job.id}${files.length ? ` (${files.length} attachment(s))` : ""}`);
      engine.subscribe(job.id, printEvent);
      const done = await engine.waitFor(job.id);
      process.exitCode = done.status === "done" ? 0 : 1;
      break;
    }
    case "probe": {
      const raw = args.positional.join("\n");
      if (!raw.trim()) throw new Error("nexova probe <links>");
      const det = detectInput(raw);
      const files = await readAttachments(list(args.flags.attach));
      const probeDir = path.join(engine.config.dataDir, "probe", String(Date.now()));
      const attachments = files.length ? await (await import("./ingest/attachments.js")).saveAttachments(files, path.join(probeDir, "attachments")) : [];
      const result = await ingest({ ...det, attachments }, { config: engine.config, log: createLogger("probe"), captureDir: path.join(probeDir, "captures"), onProgress: (m) => process.stdout.write(`\r  ${m.slice(0, 110).padEnd(110)}`) }, engine.config.offline ? undefined : (images) => engine.gateway.extractFromAttachments({ images, context: raw }, { jobId: null, onProgress: (m) => process.stdout.write(`\r  ${m.slice(0, 110).padEnd(110)}`) }));
      process.stdout.write("\n");
      for (const s of result.coverage.sources) console.log(`${s.platform.padEnd(11)} ${s.kind.padEnd(8)} ${s.status.padEnd(8)} products ${String(s.products).padStart(3)}  profile ${s.profile ? "yes" : "no "}  contacts ${s.contacts ? "yes" : "no "}  via ${s.strategies.join(",") || "-"}  tried ${s.attempted.join(",")}${s.discovered ? "  (discovered)" : ""}${s.note ? `\n             ${s.note}` : ""}`);
      for (const a of result.attachments) console.log(`attachment  ${a.name.padEnd(24)} ${a.via.padEnd(7)} ${a.platformGuess}/${a.pageType} products ${String(a.products.length).padStart(3)} conf ${a.confidence}${a.shopName ? ` shop="${a.shopName}"` : ""}${a.contacts.whatsapp ? ` wa=${a.contacts.whatsapp}` : ""}${a.notes ? ` — ${a.notes.slice(0, 80)}` : ""}`);
      console.log(`\nproducts: ${result.products.length} (${result.coverage.totals.withPrice} priced, ${result.coverage.totals.withImages} with photos), attachments: ${result.coverage.attachments.total}, score ${Math.round(result.coverage.score * 100)}%`);
      for (const p of result.products.slice(0, Number(str(args.flags.limit) ?? "25"))) console.log(`  - ${p.title} | ${p.price != null ? `${p.currency ?? ""} ${p.price}` : p.priceText ?? "?"} | via ${p.via}${p.notes?.length ? ` | ${p.notes.join("; ")}` : ""}`);
      if (result.coverage.gaps.length) console.log(`\ngaps:\n  - ${result.coverage.gaps.join("\n  - ")}`);
      if (result.coverage.recommendations.length) console.log(`\nrecommendations:\n  - ${result.coverage.recommendations.join("\n  - ")}`);
      break;
    }
    case "doctor": {
      const c = engine.config;
      const templates = await engine.templates();
      console.log("Nexova doctor");
      console.log(`  engine        v${c.engineVersion}`);
      console.log(`  mode          ${c.offline ? "OFFLINE (no API key detected)" : "online"}`);
      console.log(`  model         ${c.model} @ effort ${c.effort}`);
      console.log(`  fallbacks     ${c.fallbacks === "default" ? "default (auto-route on refusal)" : c.fallbacks ? c.fallbacks.model : "disabled"}`);
      console.log(`  reader        ${c.reader}${c.firecrawlApiKey ? " (firecrawl key set)" : ""}${c.jinaApiKey ? " (jina key set)" : ""}${c.proxyUrlTemplate ? " (proxy set)" : ""}`);
      console.log(`  browser       ${c.browser ? "on (playwright)" : "off"}`);
      console.log(`  discovery     ${c.discovery ? `on (max ${c.maxDiscovered}${c.searchDiscovery ? ", with search" : ""})` : "off"}`);
      console.log(`  wayback       ${c.wayback ? "on" : "off"}`);
      console.log(`  vision images ${c.maxVisionImages}/job`);
      console.log(`  max products  ${c.maxProducts}`);
      console.log(`  deploy        ${engine.deployer.id} -> ${c.publicUrl}`);
      console.log(`  templates     ${templates.length ? templates.map((t) => t.manifest.id).join(", ") : "NONE (add folders under " + c.templatesDir + ")"}`);
      if (c.offline) {
        console.log("\n✖ No usable ANTHROPIC_API_KEY found. Add it to .env, then run doctor again.");
        process.exitCode = 1;
        break;
      }
      process.stdout.write("\n  checking Claude access… ");
      try {
        const check = await engine.checkModelAccess();
        console.log(`ok (${check.durationMs}ms)`);
        console.log(`  served by     ${check.servedBy}`);
        console.log(`  reply         ${check.text.trim().slice(0, 60)}`);
        console.log(`  test cost     $${check.costUsd.toFixed(6)} (${check.inputTokens} in / ${check.outputTokens} out)`);
        if (args.flags.schemas) {
          console.log("\n  compiling structured-output schemas…");
          let bad = 0;
          for (const s of await engine.checkSchemas()) {
            console.log(`    ${s.ok ? "ok  " : "FAIL"} ${s.name.padEnd(32)} ${s.ms}ms${s.error ? `\n         ${s.error}` : ""}`);
            if (!s.ok) bad++;
          }
          if (bad) {
            console.error(`\n✖ ${bad} schema(s) would fail at call time. Reduce union-typed fields or schema size.`);
            process.exitCode = 1;
            break;
          }
        }
        console.log(`\n✔ Ready. Run: nexova create "<your links>" --attach shot.png${args.flags.schemas ? "" : "\n  (add --schemas to also compile the structured-output schemas)"}`);
      } catch (err) {
        console.log("FAILED");
        console.error(`\n✖ ${err instanceof Error ? err.message : String(err)}`);
        process.exitCode = 1;
      }
      break;
    }
    case "rebuild": {
      const slug = args.positional[0];
      if (!slug) throw new Error("nexova rebuild <slug>");
      const job = await engine.rebuildStore(slug, { templateId: str(args.flags.template) });
      engine.subscribe(job.id, printEvent);
      const done = await engine.waitFor(job.id);
      process.exitCode = done.status === "done" ? 0 : 1;
      break;
    }
    case "templates": {
      const templates = await engine.templates();
      if (!templates.length) console.log(`No templates in ${engine.config.templatesDir}`);
      for (const t of templates) console.log(`${t.manifest.id.padEnd(24)} ${t.manifest.name.padEnd(28)} v${t.manifest.version}  [${t.manifest.style.tags.join(", ")}]  ${t.manifest.industries.join(",") || "any"}`);
      break;
    }
    case "stores": {
      for (const s of await engine.stores.list()) console.log(`${s.slug.padEnd(28)} ${s.name.padEnd(28)} ${String(s.products).padStart(3)} products  ${s.templateId ?? "-"}  ${s.siteUrl ?? "(not deployed)"}`);
      break;
    }
    case "usage": {
      const days = Number(str(args.flags.days) ?? "0");
      const report = await engine.usage({ jobId: str(args.flags.job) ?? undefined, since: days > 0 ? new Date(Date.now() - days * 86_400_000) : undefined });
      console.log(JSON.stringify(report, null, 2));
      break;
    }
    case "job": {
      const job = await engine.getJob(args.positional[0] ?? "");
      console.log(JSON.stringify(job, null, 2));
      break;
    }
    default:
      console.log(`nexova <doctor|create|probe|rebuild|templates|stores|usage|job> ...\n\n  doctor                                                      verify API key, model access, templates\n  create "https://www.tiktok.com/@brand" "https://shopee.com.my/brand" [--attach shot.png] [--template id] [--skip-build] [--skip-discovery] [--offline]\n  probe "https://shopee.com.my/brand" [--attach shot.png]     ingestion only + coverage report\n  rebuild <slug> [--template id]\n  templates\n  stores\n  usage [--job id] [--days 7]\n  job <id>`);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
