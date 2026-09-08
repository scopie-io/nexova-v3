import type { StoreSpec } from "../../schema/store-spec.js";
import type { Logger } from "../../util/log.js";

export interface DeployInput {
  slug: string;
  distDir: string;
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
  deploy(input: DeployInput): Promise<DeployResult>;
}
