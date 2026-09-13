-- Nexova storage backend: records, append-only lines, and the public asset bucket.
--
-- Ported from the runtime DDL in packages/engine/src/storage/vercel.ts, which ran
-- CREATE TABLE IF NOT EXISTS on every cold start. The shape is deliberately unchanged
-- so the copy from Neon is row-for-row.

create table if not exists public.nexova_records (
  collection text not null,
  key        text not null,
  value      jsonb not null,
  updated_at timestamptz not null default now(),
  primary key (collection, key)
);

create index if not exists nexova_records_collection_updated
  on public.nexova_records (collection, updated_at desc);

create table if not exists public.nexova_lines (
  id   bigserial primary key,
  name text not null,
  line text not null,
  at   timestamptz not null default now()
);

create index if not exists nexova_lines_name_id
  on public.nexova_lines (name, id);

-- RLS on with zero policies: the engine connects as service_role, which bypasses RLS,
-- while anon and authenticated get nothing. That is the intended posture -- these tables
-- hold job state and merchant catalogues and are never read from the browser.
-- The database linter reports this as INFO rls_enabled_no_policy; that is expected.
alter table public.nexova_records enable row level security;
alter table public.nexova_lines   enable row level security;

-- Public bucket, matching today's Vercel Blob semantics: storefront images must be
-- readable without a token. Reads through /storage/v1/object/public/ bypass RLS.
insert into storage.buckets (id, name, public)
values ('nexova', 'nexova', true)
on conflict (id) do update set public = excluded.public;
