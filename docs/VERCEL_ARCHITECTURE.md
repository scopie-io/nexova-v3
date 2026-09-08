# Nexova on Vercel — architecture plan

Status: phases 1 to 3 implemented, 2026-09-08; phase 4 (cutover) pending Neon terms and a Vercel token. Supersedes the "runs on a merchant's PC" deployment model in the README once complete.

## Why this needs re-architecture

Today one Node process does everything: serves the web app, runs 5 to 10 minute build jobs in memory, writes jobs, caches, stores, images, and usage to local disk, and shells out to `npm install` and `vite build` for every store. Vercel Functions have no persistent disk, are limited to 300 s per invocation (800 s on Pro), and cannot keep an in-memory job running between requests. Four things must change:

| Today | On Vercel |
|---|---|
| In-process job loop, `JobBus` in memory, SSE from memory | Workflow SDK run per job; each pipeline step is a durable `"use step"`; progress streamed from the run |
| `data/`, `stores/`, `.env` on disk | Neon Postgres for records (jobs, stores, usage, source cache); Vercel Blob for files (uploads, captures, downloaded images, large artifacts) |
| `vite build` spawned locally, output copied to `stores/<slug>/live` | Composed site source uploaded through the Vercel Deployments API; Vercel builds and hosts each store as its own project |
| One port serves app, API, and stores | One Vercel project serves the app and API; each store is `nexova-<slug>.vercel.app` (custom domains later) |

Everything else in the engine (detection, ingestion providers, Claude gateway, mapping, schemas, templates contract) is pure logic and moves unchanged.

## Target layout

```
Vercel project "nexova"  (root directory: packages/server)
  /                 packages/web (static Vite build, served by Nitro publicAssets)
  /api/*            packages/server/src/app.ts: Hono on a Vercel Function (Nitro, preset vercel)
  workflows         packages/server/src/workflows/build-store.ts: one Workflow step per stage,
                    emitted as .well-known/workflow/v1/{flow,step}.func with queue triggers
  templates         packages/server/src/templates.bundle.ts, generated at build time from templates/
                    by scripts/bundle-templates.mjs (no template folder on the function)

Neon Postgres       jobs, job_steps (inside jobs json), artifacts (small, jsonb), stores (spec jsonb + meta),
                    usage_ledger, source_cache (url, signals jsonb, saved_at), slugs
Vercel Blob         attachments/<job>/…, captures/<job>/…, images/<slug>/…, artifacts/<job>/… (large)

Vercel project per store "nexova-<slug>"
  created and deployed through the Deployments API from the composed site source;
  Vercel runs the template's build; rebuild = new deployment
```

## Engine changes

### Storage abstraction

A `Storage` interface with two implementations, selected by environment:

- `FsStorage` (default): current behaviour under `data/` and `stores/`. Keeps the CLI, tests, and offline mode working exactly as now.
- `VercelStorage`: Neon for records, Blob for bytes. Selected when `DATABASE_URL` and `BLOB_READ_WRITE_TOKEN` are set.

Consumers that switch from `fs`/`path` to `Storage`: `JobStore`, `StoreRepository`, `UsageLedger`, `SourceCache`, `saveAttachments`, `localizeAssets`, and the vision image loader in the Anthropic gateway (reads bytes by reference, not by path).

### Images

`localizeAssets` uploads each image to Blob and rewrites spec URLs to the absolute Blob URL. The template's `assetUrl` already passes absolute URLs through, so no `public/nexova/images` copy is needed and composed sites stay small. Locally, FsStorage keeps the current relative-path behaviour.

### Pipeline as a workflow

`buildStore(jobId)` with `"use workflow"` orchestrating these steps, each bounded to fit one function invocation:

| Step | Notes |
|---|---|
| detect | unchanged |
| ingestUrl × N | one step per pasted URL, run in parallel; the provider ladder and source cache unchanged |
| discover, then ingestUrl × M | same |
| attachments | local parsing plus vision; batches of 20 images if needed |
| research | hard cap 240 s inside the step; never fatal (unchanged rule) |
| normalizeStore | one call |
| normalizeProducts × B | one step per batch of 12, sequential (each depends on `store`) |
| assets | chunks of 40 images per step |
| enrich | one call |
| template | unchanged |
| compose + deploy | compose in memory, upload source to the Vercel Deployments API, poll until READY |

Each step persists the `JobRecord` to Neon and writes a progress event to the run's stream, so the web app's existing event model keeps working. The API's SSE endpoint reads `run.getReadable()` instead of the in-memory bus. Retries: Workflow handles transient failures; `FatalError` for merchant-input problems.

`rebuildStore(slug)` becomes a second, short workflow: template, compose, deploy.

### Store deployment

`VercelDeployer` implements the existing `Deployer` interface using the Vercel REST API:

1. Find or create project `nexova-<slug>` in the team, framework preset `vite`.
2. Create a deployment with inline files: the template folder minus `node_modules`, plus `src/nexova/store.json` and `theme.css`. Env `NEXOVA_BASE_PATH=/`.
3. Poll the deployment until `READY`; return the production URL.

The local `LocalDeployer` and `NetlifyDeployer` remain for the FS mode.

### What is off on Vercel

- Playwright provider (no browser in the function). Readers, Wayback, and the TikTok Shop API cover the same ground.
- `nexova doctor --schemas` and other CLI commands keep working locally against FsStorage; they are not deployed.

## How it is wired (as built)

- `packages/engine/src/storage/` is the Storage seam: `FsStorage` keeps today's layout, `VercelStorage` uses two generic Neon tables (`nexova_records`, `nexova_lines`) and Vercel Blob. `NEXOVA_STORAGE=auto` picks Neon+Blob when `DATABASE_URL` and `BLOB_READ_WRITE_TOKEN` are set.
- `packages/engine/src/pipeline/stages.ts` holds every pipeline stage as a function over job artifacts; `pipeline.ts` (local, in-process) and `packages/server/src/workflows/build-store.ts` (Workflow steps) are thin sequences over the same stages. A job's artifact map lives on the job record, so every step must save the record before the next invocation reads it.
- `packages/server/src/app.ts` is the Hono API with a `JobLauncher` abstraction: `inProcessLauncher` (local `index.ts`) or `workflowLauncher` (`nitro.ts`), which starts runs and turns the run's stream into the same SSE events the web app already consumes. `JobRecord.runId` links a job to its run.
- On Vercel, compose + build + deploy happen in one step (`stagePublish`): the site is composed in memory from the template bundle and pushed through `VercelDeployer.deploySource`, which creates `nexova-<slug>` and lets Vercel run the Vite build. Locally the same stage falls back to the on-disk compose/build/deploy.
- Research is capped at 240 s inside its step so it fits a Hobby-plan function; ingestion of many links is the next candidate for splitting into parallel steps.
- Workflow retries are set to 0 on every step that calls Claude; the engine's own single retry inside `runStep` still applies.
- Vercel build: `packages/server/vercel.json` runs the monorepo build from the repo root; `nitro build` with the `vercel` preset writes `packages/server/.vercel/output` including the two workflow functions (`maxDuration: max`, `nodejs22.x`).
- Local cloud-mode dev: `npm run dev:cloud` (bundles templates, runs `nitro dev` with the Local World). `npx workflow web` shows runs.

## Environment variables (Vercel project)

| Variable | Purpose |
|---|---|
| `ANTHROPIC_API_KEY`, `NEXOVA_MODEL`, `NEXOVA_EFFORT` | Claude, unchanged |
| `RAPIDAPI_KEY`, `NEXOVA_TIKTOK_SHOP_*` | TikTok Shop API, unchanged |
| `DATABASE_URL` | Neon, provisioned through the Vercel Marketplace |
| `BLOB_READ_WRITE_TOKEN` | Vercel Blob store |
| `VERCEL_TOKEN`, `VERCEL_TEAM_ID` | Deployments API for store projects |
| `NEXOVA_DEPLOY_TARGET=vercel` | Publish stores to their own Vercel projects |
| `NEXOVA_STORAGE=vercel` | Force Neon+Blob (auto-detected when both are set) |
| `NEXOVA_RESEARCH_TIMEOUT_MS=240000` | Keep research inside one function invocation |
| `NEXOVA_PUBLIC_URL` | The Nexova app URL |

## Phases

| Phase | Deliverable | Verifiable by | Effort |
|---|---|---|---|
| 1. Storage | `Storage` interface, `FsStorage`, `VercelStorage` (Neon + Blob), consumers migrated, schema migration script | Existing tests pass on FsStorage; a local run with `DATABASE_URL` and Blob set writes to Neon and Blob | 1 day |
| 2. Store deploy | `VercelDeployer`, images on Blob | From the local server, `NEXOVA_DEPLOY_TARGET=vercel` publishes the Goli store to `nexova-goli-nutrition.vercel.app` | 0.5 day |
| 3. Workflow | Pipeline split into steps, Hono on Nitro with `workflow/nitro`, SSE from run streams, jobs in Neon | `nitro dev` locally runs a full job through the workflow runtime; `npx workflow web` shows the steps | 1.5 days |
| 4. Cutover | Vercel project, Marketplace Neon and Blob, env vars, web app static, README and PRD updated | Paste the Goli link on the deployed app, watch progress, open the live store | 0.5 day |

Phases 1 and 2 are useful on their own even before the server moves: the local server gains cloud storage and Vercel-hosted stores.

## Risks

- **Step duration.** Research and large normalize batches must stay under the plan's function limit. Caps are in the design; the Pro plan's 800 s gives headroom.
- **Vercel project count.** One project per store. Hobby allows 200 projects per account; Pro is higher. A fallback is a single "stores" project serving `/<slug>/` from Blob through a function, at the cost of slower stores.
- **Workflow SDK maturity.** It is the documented Vercel path for multi-minute jobs, but it is newer than the rest of the stack. The pipeline stays a plain async function per step so it can run under any orchestrator.
- **Cost.** Neon and Blob have free tiers that cover development. Function time per job is dominated by waiting on Claude, which Active CPU pricing bills lightly.

## Decisions taken

- Keep the FS mode. It is how tests and the CLI run, and the abstraction is thin.
- Let Vercel build stores rather than running Vite in a function or a Sandbox. It is simpler, faster to ship, and gives each store a real CDN-hosted deployment with a URL.
- Neon over Blob-only for records. Listing, filtering, and concurrent writes to jobs and usage need a database.
