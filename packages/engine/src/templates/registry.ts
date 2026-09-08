/**
 * Template registry: discovers `templates/<id>/nexova.template.json`, validates manifests,
 * and makes sure a template's dependencies are installed before it is built.
 */
import path from "node:path";
import type { EngineConfig } from "../config.js";
import { TemplateManifestSchema, type TemplateEntry, type TemplateManifest } from "../schema/manifest.js";
import { exists, listDirs, readJsonOrNull } from "../util/fsx.js";
import { createLogger, type Logger } from "../util/log.js";
import { runCommand, tail } from "../util/proc.js";

const log = createLogger("templates");

export class TemplateRegistry {
  private cache: TemplateEntry[] | null = null;
  private installing = new Map<string, Promise<void>>();

  constructor(private readonly config: EngineConfig) {}

  invalidate(): void {
    this.cache = null;
  }

  async list(force = false): Promise<TemplateEntry[]> {
    if (this.cache && !force) return this.cache;
    const entries: TemplateEntry[] = [];
    const problems: string[] = [];
    for (const name of await listDirs(this.config.templatesDir)) {
      if (name.startsWith(".") || name.startsWith("_") || name === "node_modules") continue;
      const dir = path.join(this.config.templatesDir, name);
      const manifestPath = path.join(dir, "nexova.template.json");
      const raw = await readJsonOrNull(manifestPath);
      if (!raw) {
        if (await exists(path.join(dir, "package.json"))) problems.push(`${name}: missing nexova.template.json (see docs/TEMPLATE_CONTRACT.md)`);
        continue;
      }
      const parsed = TemplateManifestSchema.safeParse(raw);
      if (!parsed.success) {
        problems.push(`${name}: invalid manifest: ${parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`);
        continue;
      }
      if (!(await exists(path.join(dir, "package.json")))) {
        problems.push(`${name}: missing package.json`);
        continue;
      }
      if (entries.some((e) => e.manifest.id === parsed.data.id)) {
        problems.push(`${name}: duplicate template id ${parsed.data.id}`);
        continue;
      }
      entries.push({ manifest: parsed.data, dir });
    }
    for (const p of problems) log.warn(p);
    entries.sort((a, b) => a.manifest.id.localeCompare(b.manifest.id));
    this.cache = entries;
    return entries;
  }

  async manifests(): Promise<TemplateManifest[]> {
    return (await this.list()).map((e) => e.manifest);
  }

  async get(id: string): Promise<TemplateEntry | null> {
    return (await this.list()).find((e) => e.manifest.id === id) ?? null;
  }

  /** Install template dependencies once (shared by every store built from it). */
  async ensureInstalled(entry: TemplateEntry, jobLog: Logger = log, signal?: AbortSignal): Promise<void> {
    const nm = path.join(entry.dir, "node_modules");
    if (await exists(nm)) return;
    const key = entry.manifest.id;
    if (!this.installing.has(key)) {
      const p = (async () => {
        jobLog.info(`installing dependencies for template ${key} (first use)…`);
        const res = await runCommand(entry.manifest.build.install, { cwd: entry.dir, signal, timeoutMs: 15 * 60_000, log: jobLog });
        if (res.code !== 0) throw new Error(`template ${key} install failed (exit ${res.code}):\n${tail(res.stderr || res.stdout)}`);
        jobLog.info(`template ${key} dependencies installed in ${Math.round(res.durationMs / 1000)}s`);
      })().finally(() => this.installing.delete(key));
      this.installing.set(key, p);
    }
    await this.installing.get(key)!;
  }
}
