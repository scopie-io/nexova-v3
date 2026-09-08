import path from "node:path";
import type { TemplateEntry } from "../schema/manifest.js";
import { exists } from "../util/fsx.js";
import type { Logger } from "../util/log.js";
import { runCommand, tail } from "../util/proc.js";

export interface BuildInput {
  siteDir: string;
  template: TemplateEntry;
  basePath: string;
  slug: string;
  log: Logger;
  signal?: AbortSignal;
  onLine?: (line: string) => void;
}

export interface BuildResult {
  outDir: string;
  durationMs: number;
}

export async function buildSite(input: BuildInput): Promise<BuildResult> {
  const { siteDir, template, log } = input;
  const build = template.manifest.build;
  if (!(await exists(path.join(siteDir, "node_modules")))) {
    log.info("installing site dependencies…");
    const inst = await runCommand(build.install, { cwd: siteDir, signal: input.signal, timeoutMs: 15 * 60_000, onLine: input.onLine });
    if (inst.code !== 0) throw new Error(`dependency install failed (exit ${inst.code}):\n${tail(inst.stderr || inst.stdout)}`);
  }
  const env = { [build.basePathEnv]: input.basePath, NEXOVA_SLUG: input.slug, NEXOVA_BASE_PATH: input.basePath, NODE_ENV: "production" };
  log.info(`building with "${build.build}" (base ${input.basePath})`);
  const res = await runCommand(build.build, { cwd: siteDir, env, signal: input.signal, timeoutMs: 10 * 60_000, onLine: input.onLine });
  if (res.code !== 0) throw new Error(`build failed (exit ${res.code}):\n${tail(res.stderr || res.stdout, 40)}`);
  const outDir = path.join(siteDir, build.outDir);
  if (!(await exists(path.join(outDir, "index.html")))) throw new Error(`build finished but ${build.outDir}/index.html is missing`);
  log.info(`build ok in ${Math.round(res.durationMs / 1000)}s`);
  return { outDir, durationMs: res.durationMs };
}
