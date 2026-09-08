/**
 * Vercel deployer: every store becomes its own Vercel project (`nexova-<slug>`) and each build a
 * production deployment, through the REST API only (no CLI). Files are announced by SHA-1 and
 * uploaded only when Vercel does not already have them, then the deployment is polled to READY.
 *
 * Two modes:
 *   - dist:   upload a built static site (what the local pipeline produces today)
 *   - source: upload the composed template source and let Vercel run the Vite build
 *             (used once the engine runs on Vercel and cannot build locally)
 */
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { EngineConfig } from "../../config.js";
import { sleep } from "../../util/retry.js";
import type { Deployer, DeployInput, DeployResult } from "./types.js";

const API = "https://api.vercel.com";
const IGNORE = new Set(["node_modules", ".git", ".vercel", ".DS_Store", "dist", ".vite", ".cache"]);

interface VercelProject {
  id: string;
  name: string;
}

interface VercelDeployment {
  id: string;
  url: string;
  readyState: "QUEUED" | "BUILDING" | "INITIALIZING" | "READY" | "ERROR" | "CANCELED";
  alias?: string[];
  errorMessage?: string;
}

export class VercelDeployer implements Deployer {
  readonly id = "vercel";
  constructor(private readonly config: EngineConfig) {}

  /** Stores hosted on Vercel live at the root of their own project. */
  basePath(_slug: string): string {
    return "/";
  }

  projectName(slug: string): string {
    return `nexova-${slug}`.toLowerCase().replace(/[^a-z0-9-]+/g, "-").slice(0, 100);
  }

  private get token(): string {
    const t = this.config.vercelToken;
    if (!t) throw new Error("VERCEL_TOKEN is not set (create one at vercel.com/account/tokens with access to the team)");
    return t;
  }

  private withTeam(route: string): string {
    const team = this.config.vercelTeamId;
    if (!team) return `${API}${route}`;
    return `${API}${route}${route.includes("?") ? "&" : "?"}teamId=${encodeURIComponent(team)}`;
  }

  private async api<T>(method: string, route: string, body?: unknown): Promise<T> {
    const res = await fetch(this.withTeam(route), {
      method,
      headers: { authorization: `Bearer ${this.token}`, "content-type": "application/json" },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) throw new Error(`Vercel ${method} ${route} failed: HTTP ${res.status} ${(await res.text()).slice(0, 400)}`);
    return (await res.json()) as T;
  }

  async ensureProject(slug: string, framework: string | null): Promise<VercelProject> {
    const name = this.projectName(slug);
    try {
      return await this.api<VercelProject>("GET", `/v9/projects/${encodeURIComponent(name)}`);
    } catch (err) {
      if (!/HTTP 404/.test(String(err))) throw err;
    }
    return this.api<VercelProject>("POST", `/v11/projects`, { name, framework });
  }

  private async uploadFile(sha: string, data: Buffer): Promise<void> {
    const res = await fetch(this.withTeam(`/v2/files`), {
      method: "POST",
      headers: { authorization: `Bearer ${this.token}`, "content-type": "application/octet-stream", "x-vercel-digest": sha, "content-length": String(data.byteLength) },
      body: new Uint8Array(data),
    });
    if (!res.ok && res.status !== 409) throw new Error(`Vercel file upload failed: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`);
  }

  async deploy(input: DeployInput): Promise<DeployResult> {
    const mode = input.sourceDir ? "source" : "dist";
    const dir = input.sourceDir ?? input.distDir;
    const project = await this.ensureProject(input.slug, mode === "source" ? (input.framework ?? "vite") : null);
    input.log.info(`vercel project ${project.name} (${project.id}), ${mode} deploy`);

    const files: Array<{ file: string; sha: string; size: number; abs: string }> = [];
    for (const rel of await walk(dir)) {
      const abs = path.join(dir, rel);
      const data = await fs.readFile(abs);
      files.push({ file: rel.split(path.sep).join("/"), sha: createHash("sha1").update(data).digest("hex"), size: data.byteLength, abs });
    }
    let uploaded = 0;
    for (const f of files) {
      await this.uploadFile(f.sha, await fs.readFile(f.abs));
      uploaded++;
    }
    input.log.info(`vercel: ${uploaded} files uploaded, creating deployment…`);

    const deployment = await this.api<VercelDeployment>("POST", `/v13/deployments?skipAutoDetectionConfirmation=1`, {
      name: project.name,
      project: project.id,
      target: "production",
      files: files.map(({ file, sha, size }) => ({ file, sha, size })),
      projectSettings: mode === "source" ? { framework: input.framework ?? "vite", buildCommand: input.buildCommand ?? null, outputDirectory: input.outputDir ?? null, installCommand: null } : { framework: null, buildCommand: null, outputDirectory: null, installCommand: null },
      meta: { nexovaSlug: input.slug, nexovaTemplate: input.spec.template.id ?? "" },
    });

    const deadline = Date.now() + 10 * 60_000;
    let state: VercelDeployment = deployment;
    while (Date.now() < deadline) {
      if (state.readyState === "READY") break;
      if (state.readyState === "ERROR" || state.readyState === "CANCELED") throw new Error(`Vercel deployment ${state.readyState}: ${state.errorMessage ?? "see the Vercel dashboard"}`);
      await sleep(3000, input.signal);
      state = await this.api<VercelDeployment>("GET", `/v13/deployments/${deployment.id}`);
    }
    if (state.readyState !== "READY") throw new Error("Vercel deployment timed out");

    const productionAlias = (state.alias ?? []).find((a) => a === `${project.name}.vercel.app`) ?? (state.alias ?? [])[0] ?? state.url;
    const url = `https://${productionAlias.replace(/^https?:\/\//, "")}`;
    input.log.info(`vercel: live at ${url}`);
    return { url, provider: this.id, details: { projectId: project.id, projectName: project.name, deploymentId: deployment.id, uploaded, mode } };
  }
}

async function walk(dir: string, rel = ""): Promise<string[]> {
  const out: string[] = [];
  for (const e of await fs.readdir(dir, { withFileTypes: true })) {
    if (IGNORE.has(e.name)) continue;
    const r = rel ? path.join(rel, e.name) : e.name;
    if (e.isSymbolicLink()) continue;
    if (e.isDirectory()) out.push(...(await walk(path.join(dir, e.name), r)));
    else if (e.isFile()) out.push(r);
  }
  return out;
}
