/**
 * Local deployer: publishes the built site to stores/<slug>/live, which the Nexova server
 * serves at /s/<slug>/. Atomic swap so a rebuild never shows a half-copied site.
 */
import path from "node:path";
import { promises as fs } from "node:fs";
import type { EngineConfig } from "../../config.js";
import { copyDir, ensureDir, rmrf } from "../../util/fsx.js";
import type { Deployer, DeployInput, DeployResult } from "./types.js";

export function liveDirFor(config: EngineConfig, slug: string): string {
  return path.join(config.storesDir, slug, "live");
}

export function localStoreUrl(config: EngineConfig, slug: string): string {
  return `${config.publicUrl}/s/${slug}/`;
}

export class LocalDeployer implements Deployer {
  readonly id = "local";
  constructor(private readonly config: EngineConfig) {}

  async deploy(input: DeployInput): Promise<DeployResult> {
    const live = liveDirFor(this.config, input.slug);
    const staging = `${live}.next`;
    await rmrf(staging);
    await ensureDir(staging);
    const files = await copyDir(input.distDir, staging, { ignore: [] });
    const old = `${live}.old`;
    await rmrf(old);
    try {
      await fs.rename(live, old);
    } catch {
      /* first deploy */
    }
    await fs.rename(staging, live);
    await rmrf(old);
    const url = localStoreUrl(this.config, input.slug);
    input.log.info(`published locally: ${url}`, { files });
    return { url, provider: this.id, details: { liveDir: live, files } };
  }
}
