/**
 * Nitro entry (Vercel): the same Hono API, with jobs as Workflow runs. Static files (the web app)
 * are served by the host from publicAssets; stores live on their own Vercel projects.
 */
import { createApp } from "./app.js";
import { getEngine } from "./engine.js";
import { workflowLauncher } from "./workflows/launcher.js";

const engine = await getEngine();
const app = createApp({ engine, launcher: workflowLauncher(engine), webDist: null, serveStores: false });

export default app;
