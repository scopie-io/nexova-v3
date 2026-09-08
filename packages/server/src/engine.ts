/**
 * One Engine per process for the hosted server and its Workflow steps. Templates come from the
 * build-time bundle (no templates folder on Vercel); everything else is configured from env.
 */
import { Engine } from "@nexova/engine";
import bundle from "./templates.bundle.js";

let instance: Promise<Engine> | null = null;

export function getEngine(): Promise<Engine> {
  if (!instance) instance = Engine.create({ rootDir: process.cwd(), templateBundle: bundle });
  return instance;
}
