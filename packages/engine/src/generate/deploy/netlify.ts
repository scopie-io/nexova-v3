/**
 * Netlify deployer using the file-digest API (no zip, no CLI): create/find a site, announce
 * file hashes, upload only what Netlify asks for, wait until the deploy is ready.
 */
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { EngineConfig } from "../../config.js";
import { sleep } from "../../util/retry.js";
import type { Deployer, DeployInput, DeployResult } from "./types.js";

const API = "https://api.netlify.com/api/v1";

export class NetlifyDeployer implements Deployer {
  readonly id = "netlify";
  constructor(private readonly config: EngineConfig) {}

  private async api<T>(method: string, route: string, body?: unknown, raw?: Buffer): Promise<T> {
    const token = this.config.netlifyToken;
    if (!token) throw new Error("NETLIFY_AUTH_TOKEN is not set");
    const res = await fetch(`${API}${route}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": raw ? "application/octet-stream" : "application/json",
      },
      body: raw ? new Uint8Array(raw) : body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) throw new Error(`Netlify ${method} ${route} failed: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`);
    return (await res.json()) as T;
  }

  async deploy(input: DeployInput): Promise<DeployResult> {
    const name = `nexova-${input.slug}`.slice(0, 60);
    const sites = await this.api<Array<{ id: string; name: string; ssl_url: string }>>("GET", `/sites?name=${encodeURIComponent(name)}`);
    let site = sites.find((s) => s.name === name);
    if (!site) site = await this.api<{ id: string; name: string; ssl_url: string }>("POST", `/sites`, { name });
    input.log.info(`netlify site ${site.name} (${site.id})`);

    const files: Record<string, string> = {};
    const byHash = new Map<string, string>();
    for (const rel of await walk(input.distDir)) {
      const abs = path.join(input.distDir, rel);
      const sha = createHash("sha1").update(await fs.readFile(abs)).digest("hex");
      const key = "/" + rel.split(path.sep).join("/");
      files[key] = sha;
      byHash.set(sha, abs);
    }
    const deploy = await this.api<{ id: string; required: string[] }>("POST", `/sites/${site.id}/deploys`, { files, draft: false });
    const required = new Set(deploy.required ?? []);
    let uploaded = 0;
    for (const [key, sha] of Object.entries(files)) {
      if (!required.has(sha)) continue;
      const abs = byHash.get(sha)!;
      await this.api("PUT", `/deploys/${deploy.id}/files${encodeURI(key)}`, undefined, await fs.readFile(abs));
      uploaded++;
    }
    input.log.info(`netlify: uploaded ${uploaded}/${Object.keys(files).length} files, waiting for deploy…`);
    for (let i = 0; i < 60; i++) {
      const state = await this.api<{ state: string; ssl_url?: string; deploy_ssl_url?: string; error_message?: string }>("GET", `/deploys/${deploy.id}`);
      if (state.state === "ready") return { url: state.ssl_url ?? site.ssl_url, provider: this.id, details: { siteId: site.id, deployId: deploy.id, uploaded } };
      if (state.state === "error") throw new Error(`Netlify deploy failed: ${state.error_message ?? "unknown"}`);
      await sleep(2000, input.signal);
    }
    throw new Error("Netlify deploy timed out");
  }
}

async function walk(dir: string, rel = ""): Promise<string[]> {
  const out: string[] = [];
  for (const e of await fs.readdir(dir, { withFileTypes: true })) {
    const r = rel ? path.join(rel, e.name) : e.name;
    if (e.isDirectory()) out.push(...(await walk(path.join(dir, e.name), r)));
    else if (e.isFile()) out.push(r);
  }
  return out;
}
