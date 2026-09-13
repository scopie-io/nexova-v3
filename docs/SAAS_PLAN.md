# Nexova V3 SaaS plan

Status: agreed 2026-09-14. Phase 0 in progress on branch `p0-foundations`.
Long-form version with diagrams: the "Nexova V3 SaaS Blueprint" artifact.

## Goal

A TikTok Shop or Shopee seller pastes their shop link and gets a store they run every day: accounts,
dashboard, inventory, orders, payments, catalogue sync and billing, at the level of nexova.my.

## Decisions

| Decision | Choice | Why |
|---|---|---|
| Relationship to nexova.my | **V3 replaces nexova.my.** Build in this repo; at launch V3 takes over the nexova.my domain and brand | nexova.my has no active users, so there is nothing to migrate. Its codebase (Next 14, `ignoreBuildErrors`, user-as-tenant schema, 131 drifted migrations) would cost more to bend than to leave. Port its integrations (LeanX, EasyParcel, subscriptions, domains, email) instead |
| Framework | One Next.js 16 app, `apps/web` (`@nexova/app`), App Router with Cache Components | Serves marketing, builder, dashboard and every storefront from one Vercel project |
| Database | Supabase project `njibepgtgyqnjmioyucz` ("NexovaV3 SG", ap-southeast-1, org "Nexova Admin", Pro plan) | Clean schema; free plan can pause and take storefront images down |
| Tenancy | The **store** is the tenant; users reach it through `store_members` (owner, admin, staff) | Staff accounts and multi-store owners without rework |
| Storefront domain | `<store>.<separate storefront domain>` (e.g. nexova.store), app on nexova.my | Keeps merchant content off the brand domain's reputation and cookies. Final name decided by Phase 2 |
| First build | Allowed before signup, claimed after | Seeing your own shop as a site is the conversion moment. Protected by BotID, per-IP caps and a daily spend cap |
| Payments at launch | LeanX (merchant's own keys), COD, WhatsApp | LeanX is already integrated in nexova.my |
| Hosting | Vercel Hobby (free), team scopie-io | Chosen 2026-09-14 to keep costs at zero. Hobby's terms are non-commercial and cap functions and projects; revisit before charging merchants |
| Marketplace data | RapidAPI (TikTok Shop) and Apify (Shopee) only | Decided 2026-09-14: no TikTok Shop Partner or Shopee Open Platform applications |

## Architecture

- **Stores stop being built artefacts.** Today each store is a Vite build with products baked into
  `store.json` and its own Vercel project. In V3 the engine's last step saves the store into
  Postgres, and one Next.js app renders every store by hostname, cached per store and invalidated by
  tag when anything changes.
- `packages/engine` stays (ingest, detection, Claude, schemas); compose/build/deploy retire after
  Phase 2. `packages/db` holds the Supabase types. `packages/themes` and `packages/commerce` arrive
  in Phases 2 and 4. `packages/server`, `packages/web` and the Vite `templates/` are removed after
  cutover.
- Schema v1: `supabase/migrations/20260914000000_saas_core.sql`. Money in integer cents, one
  currency per store, child tables carry `store_id` with composite foreign keys, stock changes only
  through `adjust_stock()` (later `place_order()`) so every change lands in `inventory_movements`.

## Phases

| | Phase | Weeks | Done when |
|---|---|---|---|
| P0 | Foundations | 1 | Next app deployed; a user can sign up, log in and see an empty dashboard |
| P1 | Builder on Next.js, claim flow | 2 | A pasted Goli link becomes an owned store with its products in Postgres in under 2 minutes |
| P2 | Storefront served from the database | 2 | A price changed in SQL shows on the store within seconds; the 8 `nexova-*.vercel.app` stores are imported |
| P3 | Merchant dashboard | 3 | Merchant edits products, variants, stock and theme; storefront updates straight away |
| P4 | Checkout, payments, orders | 3 | LeanX sandbox order paid, stock decremented, emails sent, AWB booked |
| P5 | Channel sync, tier 1 | 2 | Scheduled sync picks up a TikTok price change and respects locked fields |
| P6 | SaaS billing and admin | 1.5 | Trial to paid RM79 plan; limits enforced |
| P7 | Launch hardening | 1.5-2 | 5 pilot merchants live on their own domains |

Sync stays on RapidAPI and Apify. Without the official marketplace APIs, stock flows one way
(marketplace to website) and marketplace orders are not imported; each store chooses whether Nexova
or the marketplace owns stock counts.

## Phase 0 checklist

- [x] Plan and decisions recorded (this file)
- [x] `apps/web`: Next.js 16.3, Tailwind 4, shadcn/ui, Nexova brand (Satoshi, teal)
- [x] Supabase Auth: email and password, Google, callback route, session refresh in `proxy.ts`,
      server-side user checks (`requireUser`)
- [x] Dashboard shell: store list and create-store form through `create_store()`
- [x] Migration v1 (tenancy, settings, catalogue, inventory movements, build jobs, usage ledger) with RLS
- [x] 36 RLS checks runnable on plain Postgres (`npm run db:test`), types generated without Docker
      (`npm run db:types`)
- [x] CI: engine tests, app typecheck/lint/build, migrations + RLS + type drift
- [x] Vercel stays on Hobby (decided); Supabase org "Nexova Admin" is on Pro
- [x] Moved to Singapore: project "NexovaV3 SG" created, all three migrations applied (2026-09-14);
      the Seoul project `yyoqjrekwrilxjgbbdwj` is unused
- [ ] **You:** delete the Seoul project "NexovaV3" (`yyoqjrekwrilxjgbbdwj`) in the Supabase dashboard; projects
      on a paid org can't be paused, so it keeps billing until deleted
- [ ] **You:** Supabase Auth settings on "NexovaV3 SG": Site URL `https://nexova-app.vercel.app`, redirect
      URLs `https://nexova-app.vercel.app/auth/callback` and `http://localhost:3000/auth/callback`, Google
      provider (the settings made on the Seoul project do not carry over)
- [x] Vercel project `nexova-app` (team scopie-io, root `apps/web`, Node 22) with Supabase env vars;
      first production deploy at https://nexova-app.vercel.app (behind Vercel Deployment Protection)
- [x] Advisor follow-up migration: split catalogue write policies, index every foreign key
- [ ] Connect the GitHub repo to `nexova-app` so pushes deploy (`vercel git connect`)
- [ ] Move CI and local development to Node 22 (supabase-js deprecates Node 20)
