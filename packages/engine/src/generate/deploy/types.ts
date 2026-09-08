import type { StoreSpec } from "../../schema/store-spec.js";
import type { Logger } from "../../util/log.js";

export interface DeployInput {
  slug: string;
  /** Built static site (index.html at the root). */
  distDir: string;
  /** Composed site source, for deployers that run the build themselves (Vercel). */
  sourceDir?: string;
  framework?: string | null;
  buildCommand?: string | null;
  outputDir?: string | null;
  spec: StoreSpec;
  log: Logger;
  signal?: AbortSignal;
}

export interface DeployResult {
  url: string;
  provider: string;
  details: Record<string, unknown>;
}

export interface Deployer {
  id: string;
  /** The URL path the site is built for (`/s/<slug>/` on the local server, `/` on a real host). */
  basePath(slug: string): string;
  deploy(input: DeployInput): Promise<DeployResult>;
}
