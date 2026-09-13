# @nexova/app

The Nexova SaaS app: marketing site, merchant accounts and dashboard today; the store builder
(Phase 1) and every storefront (Phase 2) move in here next. Next.js 16 (App Router, Cache
Components) on Vercel, Supabase for auth, data and files. Plan: [`docs/SAAS_PLAN.md`](../../docs/SAAS_PLAN.md).

## Run it

```bash
cp apps/web/.env.example apps/web/.env.local   # fill in the Supabase keys
npm install                                     # from the repo root
npm run dev:app                                 # http://localhost:3000
```

## Layout

| Path | What it is |
|---|---|
| `src/proxy.ts` | Refreshes the Supabase session on every request; bounces signed-out users away from `/dashboard` |
| `src/lib/supabase/` | `server.ts` (acts as the user, RLS applies), `client.ts` (browser), `admin.ts` (secret key, bypasses RLS, server only), `session.ts` (used by the proxy) |
| `src/lib/auth.ts` | `getCurrentUser()` / `requireUser()` from verified token claims, and `safeNextPath()` for post-login redirects |
| `src/app/(auth)/` | Log in, sign up, Google sign-in, sign out (Server Actions) |
| `src/app/auth/callback/` | Exchanges email-confirmation and OAuth codes for a session |
| `src/app/dashboard/` | Merchant dashboard |
| `src/components/ui/` | shadcn/ui (base-nova, Base UI primitives) |

## Rules of the road

- Anything that reads cookies (the session) sits inside a `<Suspense>` boundary: Cache Components
  refuses to prerender request data.
- Merchant actions use `lib/supabase/server.ts` so RLS decides what they can touch. Reach for
  `admin.ts` only for work no user can do for themselves, and scope those queries by store id.
- Database types come from `@nexova/db`. After changing a migration: `npm run db:test` then
  `npm run db:types` (both need a local Postgres; see `scripts/test-db.sh`).
