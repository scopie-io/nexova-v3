# Nexova: Neon + Vercel Blob → Supabase

Status: planned 2026-09-10. **Phase 1 done** (migration `20260910030824_nexova_storage_backend`, bucket `nexova` live); phases 2-8 pending. Supersedes the storage half of `VERCEL_ARCHITECTURE.md`
(the Workflow, deployer and template design in that document are unaffected).

Target project: `jjfflqezfegzyugxrygv` (`admin@scopie.io's Project`), region `ap-southeast-1`,
Postgres 17.6, org `ezobspbmslgzoueocmgq` on the **free** plan. Currently empty: no `public` tables,
no storage buckets.

## The migration surface is one interface

`packages/engine/src/storage/types.ts` is the only seam between the engine and where state lives.
Nothing else in the codebase knows about Neon or Blob. Every consumer — `JobStore`,
`StoreRepository`, `UsageLedger`, `SourceCache`, `saveAttachments`, `localizeAssets` — goes through
these eleven methods:

```
get put delete list keys      records   small JSON documents in named collections
append lines                  lines     append-only logs
putBytes has                  bytes     files addressed by key, returned as a self-describing ref
init                          setup
```

So the code change is: **add a third implementation next to `FsStorage` and `VercelStorage`.**
`packages/engine/src/storage/vercel.ts` is 120 lines; `supabase.ts` will be about the same. No
consumer changes, no schema redesign, no pipeline changes.

`packages/engine/src/util/refs.ts::readRef()` reads any `https://` ref with a plain `fetch`, so
Supabase Storage public URLs work through it **unchanged**. That is the single biggest reason this
migration is small.

## What is actually there (measured 2026-09-10)

| | Count | Size |
|---|---|---|
| `nexova_records` | 279 rows across 21 collections | ~1.3 MB |
| `nexova_lines` | 480 rows across 15 logs | negligible |
| Blob objects | 249 (`images/` 248, `attachments/` 1) | 16.4 MB |
| Records embedding Blob URLs | 41 rows, 248 distinct URLs | — |
| Live deployed stores | 8 on `nexova-*.vercel.app` | — |

Collections in use: `jobs`, `stores`, `store-meta`, `source-cache`, `asset-index`, and one
`artifacts/<jobId>` collection per job (16 of them). Logs: `usage` plus one `joblog/<jobId>` per job.

Two facts that make the byte move cheap, both verified against the live Blob store:

1. All 249 objects share **one origin**, `https://gqe5geptqzkxidkq.public.blob.vercel-storage.com`.
2. `putBytes` uses `addRandomSuffix: false`, so **URL path == object key** for every object.

Therefore rewriting the 248 embedded URLs is a pure prefix swap, with the key preserved:

```
https://gqe5geptqzkxidkq.public.blob.vercel-storage.com/images/donmis/brand-hero-c68c12.jpg
https://jjfflqezfegzyugxrygv.supabase.co/storage/v1/object/public/nexova/images/donmis/brand-hero-c68c12.jpg
```

## Client choice: `supabase-js`, not a Postgres driver

`VercelStorage` uses `@neondatabase/serverless`, whose whole point is talking to Postgres over
**HTTP** so it works in a function with no connection pool. Keeping that property matters more than
keeping the raw SQL: Nexova's pipeline runs as Workflow steps, i.e. many short-lived invocations.

- **`supabase-js` (recommended).** PostgREST over HTTP — same statelessness as the Neon driver, and
  the *same client* covers Storage, so `supabase.ts` has one dependency instead of two.
- `postgres.js` over the Supavisor transaction pooler (port 6543) would keep the SQL literally
  identical, but reintroduces TCP pooling in a serverless context and needs `prepare: false`.
  It is the fallback if PostgREST proves awkward, not the default.

Every current query maps directly:

| `Storage` | `VercelStorage` today | `SupabaseStorage` |
|---|---|---|
| `get` | `SELECT value WHERE collection=$1 AND key=$2` | `.select('value').eq().eq().maybeSingle()` |
| `put` | `INSERT … ON CONFLICT (collection,key) DO UPDATE` | `.upsert(row, { onConflict: 'collection,key' })` |
| `delete` | `DELETE WHERE …` | `.delete().eq().eq()` |
| `list` | `ORDER BY updated_at DESC LIMIT $2` | `.order('updated_at', { ascending: false }).limit()` |
| `keys` | `SELECT key WHERE collection=$1` | `.select('key').eq()` **+ paging** |
| `append` | `INSERT INTO nexova_lines` | `.insert({ name, line })` |
| `lines` | `ORDER BY id ASC` | `.order('id').range()` **+ paging** |
| `putBytes` | `put(key, …, { allowOverwrite: true })` | `.storage.from('nexova').upload(key, …, { upsert: true })` |
| `has` | `head(ref)` | `HEAD` fetch on the public URL |

### Four gotchas to handle in the port

1. **PostgREST caps a response at 1000 rows.** `keys()` has no limit today and `lines('usage')` is an
   unbounded, growing ledger (50 rows now). Both need `.range()` paging loops or they will silently
   truncate later. This is a latent correctness bug the port must not inherit.
2. **`init()` runs four `CREATE TABLE/INDEX IF NOT EXISTS` statements on every cold start.** DDL is
   not reachable over PostgREST, and it should not be there anyway. Move it to a real Supabase
   migration; `SupabaseStorage.init()` becomes a no-op. This is a latency win, not just a tidy-up.
3. **RLS.** Create both tables and the bucket with RLS enabled and *no* policies. The server uses the
   `service_role` key, which bypasses RLS. `packages/web` is a **static Vite build** — the
   service_role key must never reach a `VITE_`-prefixed variable or it ships to the browser.
4. **`VercelStorage.remove()` has no callers** anywhere in the repo. Drop it rather than port it.

## Schema

One migration, matching today's shape exactly so the copy is a straight row-for-row insert:

```sql
create table nexova_records (
  collection text not null,
  key        text not null,
  value      jsonb not null,
  updated_at timestamptz not null default now(),
  primary key (collection, key)
);
create index nexova_records_collection_updated on nexova_records (collection, updated_at desc);

create table nexova_lines (
  id   bigserial primary key,
  name text not null,
  line text not null,
  at   timestamptz not null default now()
);
create index nexova_lines_name_id on nexova_lines (name, id);

alter table nexova_records enable row level security;
alter table nexova_lines   enable row level security;
```

Bucket: `nexova`, **public** (storefront images must be publicly readable), no size limit override.

Public matches today's Blob semantics exactly, including for the single `attachments/` object, which
is currently public-with-an-unguessable-name. Splitting attachments into a private bucket with
signed URLs is a genuine hardening win but needs `readRef()` to learn how to sign — out of scope
here, tracked as a follow-up.

## Configuration

`packages/engine/src/config.ts` gains a third mode. Keep `VercelStorage` in the tree: rollback then
costs one environment variable rather than a revert.

```
NEXOVA_STORAGE = auto | fs | vercel | supabase
SUPABASE_URL                        https://jjfflqezfegzyugxrygv.supabase.co
SUPABASE_SERVICE_ROLE_KEY           server-only, never VITE_-prefixed
SUPABASE_BUCKET                     default "nexova"
```

`auto` resolution order: `supabase` when URL + service key are set → `vercel` when `DATABASE_URL` +
`BLOB_READ_WRITE_TOKEN` are set → `fs`. Existing `auto` behaviour is unchanged for anyone without
Supabase vars, so the CLI, tests and offline mode keep working untouched.

## Phases

| # | Deliverable | Verified by |
|---|---|---|
| 1 | ~~Migration applied, `nexova` bucket created~~ **done** | Columns, defaults and indexes diffed against Neon: identical. Public read path resolves the bucket anonymously |
| 2 | `SupabaseStorage` + config mode + round-trip test | `storage.test.ts` third `roundTrip()` block passes against the live project |
| 3 | `scripts/migrate-to-supabase.mjs --records` | 279 records + 480 lines present; counts match Neon exactly |
| 4 | `… --bytes` | 249 objects in the bucket; every key byte-identical to its Blob source |
| 5 | `… --rewrite` | 0 rows in `nexova_records` still matching `blob.vercel-storage.com` |
| 6 | Cutover: env vars set, `NEXOVA_STORAGE=supabase`, deploy | A fresh job runs end-to-end and writes only to Supabase |
| 7 | Rebuild the 8 live stores | Each `nexova-*.vercel.app` serves images from `*.supabase.co` |
| 8 | Soak, then decommission Neon + Blob | After ~1 week clean, remove both Vercel integrations |

The script is one file with three independent, **idempotent** flags so any phase can be re-run.
Phases 3–5 are read-only against Neon and Blob — nothing is deleted until phase 8, so the old stack
stays a live fallback for the whole migration.

### Ordering constraint

Phase 5 (URL rewrite) must land **before** phase 7 (store rebuild) and **after** phase 4, because
`localizeAssets` reads `asset-index` to decide whether an image is already stored: it calls
`storage.has(cached.ref)` and reuses `cached.url`. Rebuild a store with stale Blob URLs still in
`asset-index` and it will happily keep them.

Phase 6 before phase 7 for the same reason — the rebuild must run against the Supabase-backed engine.

## Rollback

| Phase | Undo |
|---|---|
| 1–5 | Nothing to undo; Neon and Blob are untouched and still authoritative |
| 6 | Set `NEXOVA_STORAGE=vercel`, redeploy. Neon still holds everything up to cutover |
| 7 | Rebuild the stores again with `NEXOVA_STORAGE=vercel` |
| 8 | Point of no return — only after the soak |

The gap that rollback does *not* cover: jobs and stores created **after** cutover live only in
Supabase. Reverting to Neon loses them unless the copy script is run in reverse. With 8 stores and a
low job rate this is acceptable, but it is why phase 8 waits a week.

## Risks

- **Free-tier pause is the real one.** The org is on the free plan, which pauses a project after 7
  days of inactivity. Accepted deliberately for now (2026-09-10) — but note the consequence has
  changed now that bytes are moving too: a pause no longer just stalls job state, it takes the
  **images off 8 live storefronts**. Mitigation while on free: the project stays awake as long as
  Nexova is used most days; a cheap cron ping would guarantee it. This becomes a must-fix ($25/mo
  Pro) before any paying merchant is on a Nexova store.
- **Storage egress, 5 GB/month on free.** Storefront images now bill against it. 16.4 MB of assets
  is nothing, but traffic across 8 stores is the multiplier to watch. Blob absorbed this before.
- **No image transformation on free.** Supabase's image CDN is Pro-only. Today's images are served
  as-downloaded from Blob, so this is parity, not a regression.
- **Store rebuild window.** Between phase 5 and phase 7 the deployed stores still point at Blob.
  Harmless — Blob is still alive — but do not delete the Blob store early.
- **Region.** `ap-southeast-1` (Singapore) is the right choice for a Malaysian merchant base and is
  closer than the Neon project it replaces.

## Decisions taken

- **Move bytes as well as Postgres** (chosen 2026-09-10), for a single vendor for all state, at the
  cost of a byte copy, a URL rewrite and 8 store rebuilds.
- **Keep `FsStorage` untouched and `VercelStorage` in the tree.** Tests, the CLI and offline mode all
  run on `FsStorage`; `VercelStorage` is the rollback path, not dead weight.
- **Keep the two generic tables.** A relational redesign of `jobs`/`stores`/`artifacts` is tempting
  while the schema is being recreated, but it would turn a 120-line port into a rewrite of every
  consumer. Do it later, on its own, if querying ever demands it.
- **Move DDL out of `init()`** rather than reproducing it — the one place the port deliberately
  diverges from `VercelStorage`.
