-- Nexova SaaS core: accounts, stores and their members, storefront settings, the catalogue,
-- build jobs and the usage ledger. Orders, channels and billing arrive in later migrations.
--
-- Tenancy: the STORE is the tenant. Users reach a store through store_members, and every
-- tenant table carries store_id so each RLS policy is one indexed membership lookup.
-- Money is integer cents in the store's single currency (stores.currency).
-- Writes that must stay consistent (creating a store with its owner, changing stock) go
-- through security-definer functions; the matching columns are not updatable directly.

-- ---------------------------------------------------------------------------------------------
-- Types
-- ---------------------------------------------------------------------------------------------

create type public.platform_role as enum ('user', 'admin');
create type public.store_status as enum ('draft', 'live', 'suspended');
-- Declared lowest to highest so roles compare with >=.
create type public.store_role as enum ('staff', 'admin', 'owner');
create type public.domain_kind as enum ('subdomain', 'custom');
create type public.product_status as enum ('draft', 'active', 'archived');
create type public.inventory_reason as enum ('initial', 'manual', 'order', 'cancel', 'sync', 'import');
-- Mirrors JobStatus in packages/engine/src/schema/job.ts.
create type public.build_status as enum ('queued', 'running', 'done', 'failed', 'cancelled');

-- ---------------------------------------------------------------------------------------------
-- Helpers: not exposed through the Data API
-- ---------------------------------------------------------------------------------------------

create schema if not exists private;
grant usage on schema private to anon, authenticated, service_role;

create function private.touch_updated_at() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  return new;
end $$;

-- Subdomain-safe slug, also used as the store's default subdomain.
create function private.is_valid_slug(p_slug text) returns boolean
language sql immutable set search_path = '' as $$
  select p_slug ~ '^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$'
$$;

create function private.is_reserved_slug(p_slug text) returns boolean
language sql immutable set search_path = '' as $$
  select p_slug = any (array[
    'www', 'app', 'api', 'admin', 'dashboard', 'auth', 'login', 'signup', 'account', 'billing',
    'help', 'support', 'docs', 'blog', 'status', 'mail', 'email', 'static', 'assets', 'cdn',
    'img', 'images', 'preview', 'staging', 'dev', 'test', 'nexova', 'store', 'stores', 'shop'
  ])
$$;

-- ---------------------------------------------------------------------------------------------
-- Accounts
-- ---------------------------------------------------------------------------------------------

create table public.profiles (
  id            uuid primary key references auth.users (id) on delete cascade,
  display_name  text check (char_length(display_name) <= 80),
  phone         text check (char_length(phone) <= 32),
  avatar_url    text,
  platform_role public.platform_role not null default 'user',
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create trigger profiles_touch before update on public.profiles
  for each row execute function private.touch_updated_at();

create function private.handle_new_user() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.profiles (id, display_name)
  values (
    new.id,
    nullif(left(coalesce(new.raw_user_meta_data ->> 'display_name', new.raw_user_meta_data ->> 'full_name', ''), 80), '')
  )
  on conflict (id) do nothing;
  return new;
end $$;

create trigger on_auth_user_created after insert on auth.users
  for each row execute function private.handle_new_user();

create function private.is_platform_admin() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.profiles p
    where p.id = (select auth.uid()) and p.platform_role = 'admin'
  )
$$;

-- ---------------------------------------------------------------------------------------------
-- Stores and membership
-- ---------------------------------------------------------------------------------------------

create table public.stores (
  id          uuid primary key default gen_random_uuid(),
  slug        text not null unique check (private.is_valid_slug(slug)),
  name        text not null check (char_length(name) between 1 and 120),
  status      public.store_status not null default 'draft',
  currency    text not null default 'MYR' check (currency ~ '^[A-Z]{3}$'),
  locale      text not null default 'en-MY' check (char_length(locale) <= 16),
  -- Set once the merchant proves they own the marketplace shop the store was built from.
  -- Publishing and checkout are gated on it.
  verified_at timestamptz,
  created_by  uuid references auth.users (id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create trigger stores_touch before update on public.stores
  for each row execute function private.touch_updated_at();

create table public.store_members (
  store_id   uuid not null references public.stores (id) on delete cascade,
  user_id    uuid not null references auth.users (id) on delete cascade,
  role       public.store_role not null,
  created_at timestamptz not null default now(),
  primary key (store_id, user_id)
);

create unique index store_members_one_owner on public.store_members (store_id) where role = 'owner';
create index store_members_user on public.store_members (user_id);

-- True when the caller is a member of the store with at least p_min_role.
create function private.has_store_role(p_store_id uuid, p_min_role public.store_role default 'staff')
returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.store_members m
    where m.store_id = p_store_id
      and m.user_id = (select auth.uid())
      and m.role >= p_min_role
  )
$$;

-- True when the store is published: what shoppers are allowed to see.
create function private.is_live_store(p_store_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.stores s where s.id = p_store_id and s.status = 'live')
$$;

create table public.store_domains (
  id          uuid primary key default gen_random_uuid(),
  store_id    uuid not null references public.stores (id) on delete cascade,
  hostname    text not null unique
              check (hostname = lower(hostname) and hostname ~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$'),
  kind        public.domain_kind not null,
  is_primary  boolean not null default false,
  verified_at timestamptz,
  created_at  timestamptz not null default now()
);

create unique index store_domains_one_primary on public.store_domains (store_id) where is_primary;
create index store_domains_store on public.store_domains (store_id);

-- The StoreSpec minus the catalogue. Kept as documents because the engine produces them and the
-- storefront editor edits them as a whole; shapes are validated by zod in the app.
create table public.store_settings (
  store_id    uuid primary key references public.stores (id) on delete cascade,
  template_id text,
  brand       jsonb not null default '{}' check (jsonb_typeof(brand) = 'object'),
  theme       jsonb not null default '{}' check (jsonb_typeof(theme) = 'object'),
  pages       jsonb not null default '{}' check (jsonb_typeof(pages) = 'object'),
  seo         jsonb not null default '{}' check (jsonb_typeof(seo) = 'object'),
  social      jsonb not null default '{}' check (jsonb_typeof(social) = 'object'),
  contact     jsonb not null default '{}' check (jsonb_typeof(contact) = 'object'),
  policies    jsonb not null default '{}' check (jsonb_typeof(policies) = 'object'),
  checkout    jsonb not null default '{}' check (jsonb_typeof(checkout) = 'object'),
  updated_at  timestamptz not null default now()
);

create trigger store_settings_touch before update on public.store_settings
  for each row execute function private.touch_updated_at();

-- ---------------------------------------------------------------------------------------------
-- Catalogue
-- Child tables repeat store_id and reference (id, store_id) of their parent, so a row can never
-- point at another store's product and policies never need a join to find the tenant.
-- Every product has at least one variant; a product without options has a single "Default" one.
-- ---------------------------------------------------------------------------------------------

create table public.products (
  id                 uuid primary key default gen_random_uuid(),
  store_id           uuid not null references public.stores (id) on delete cascade,
  slug               text not null check (slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$' and char_length(slug) <= 120),
  title              text not null check (char_length(title) between 1 and 300),
  description        text not null default '',
  short_description  text not null default '',
  status             public.product_status not null default 'draft',
  featured           boolean not null default false,
  position           integer not null default 0,
  tags               text[] not null default '{}',
  attributes         jsonb not null default '{}' check (jsonb_typeof(attributes) = 'object'),
  seo                jsonb not null default '{}' check (jsonb_typeof(seo) = 'object'),
  rating_average     numeric(3, 2) check (rating_average between 0 and 5),
  rating_count       integer check (rating_count >= 0),
  sold_count         integer check (sold_count >= 0),
  -- Fields the merchant edited; channel sync leaves these alone.
  locked_fields      text[] not null default '{}',
  source_platform    text,
  source_url         text,
  source_external_id text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  unique (store_id, slug),
  unique (id, store_id)
);

create index products_store_status on public.products (store_id, status, position);

create trigger products_touch before update on public.products
  for each row execute function private.touch_updated_at();

create table public.product_images (
  id           uuid primary key default gen_random_uuid(),
  store_id     uuid not null,
  product_id   uuid not null,
  url          text not null,
  storage_path text,
  source_url   text,
  alt          text not null default '',
  width        integer check (width > 0),
  height       integer check (height > 0),
  position     integer not null default 0,
  created_at   timestamptz not null default now(),
  foreign key (product_id, store_id) references public.products (id, store_id) on delete cascade,
  unique (id, store_id)
);

create index product_images_product on public.product_images (product_id, position);

create table public.product_options (
  id         uuid primary key default gen_random_uuid(),
  store_id   uuid not null,
  product_id uuid not null,
  name       text not null check (char_length(name) between 1 and 60),
  "values"   text[] not null default '{}',
  position   integer not null default 0,
  foreign key (product_id, store_id) references public.products (id, store_id) on delete cascade,
  unique (product_id, name)
);

create table public.product_variants (
  id                  uuid primary key default gen_random_uuid(),
  store_id            uuid not null,
  product_id          uuid not null,
  title               text not null default 'Default' check (char_length(title) between 1 and 200),
  options             jsonb not null default '{}' check (jsonb_typeof(options) = 'object'),
  sku                 text check (char_length(sku) <= 100),
  price_cents         bigint not null check (price_cents >= 0),
  compare_at_cents    bigint check (compare_at_cents >= 0),
  track_stock         boolean not null default true,
  stock_qty           integer not null default 0,
  allow_backorder     boolean not null default false,
  low_stock_threshold integer check (low_stock_threshold >= 0),
  weight_g            integer check (weight_g >= 0),
  image_id            uuid,
  position            integer not null default 0,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  foreign key (product_id, store_id) references public.products (id, store_id) on delete cascade,
  foreign key (image_id) references public.product_images (id) on delete set null,
  unique (id, store_id)
);

create index product_variants_product on public.product_variants (product_id, position);
create unique index product_variants_store_sku on public.product_variants (store_id, sku) where sku is not null;

create trigger product_variants_touch before update on public.product_variants
  for each row execute function private.touch_updated_at();

create table public.categories (
  id          uuid primary key default gen_random_uuid(),
  store_id    uuid not null references public.stores (id) on delete cascade,
  slug        text not null check (slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$' and char_length(slug) <= 120),
  name        text not null check (char_length(name) between 1 and 120),
  description text not null default '',
  image_url   text,
  position    integer not null default 0,
  created_at  timestamptz not null default now(),
  unique (store_id, slug),
  unique (id, store_id)
);

create table public.product_categories (
  store_id    uuid not null,
  product_id  uuid not null,
  category_id uuid not null,
  position    integer not null default 0,
  primary key (product_id, category_id),
  foreign key (product_id, store_id) references public.products (id, store_id) on delete cascade,
  foreign key (category_id, store_id) references public.categories (id, store_id) on delete cascade
);

create index product_categories_category on public.product_categories (category_id, position);

create table public.collections (
  id          uuid primary key default gen_random_uuid(),
  store_id    uuid not null references public.stores (id) on delete cascade,
  slug        text not null check (slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$' and char_length(slug) <= 120),
  name        text not null check (char_length(name) between 1 and 120),
  description text not null default '',
  image_url   text,
  position    integer not null default 0,
  created_at  timestamptz not null default now(),
  unique (store_id, slug),
  unique (id, store_id)
);

create table public.collection_products (
  store_id      uuid not null,
  collection_id uuid not null,
  product_id    uuid not null,
  position      integer not null default 0,
  primary key (collection_id, product_id),
  foreign key (collection_id, store_id) references public.collections (id, store_id) on delete cascade,
  foreign key (product_id, store_id) references public.products (id, store_id) on delete cascade
);

create index collection_products_product on public.collection_products (product_id);

-- Append-only record of every stock change. Only adjust_stock() and, later, place_order() write it.
create table public.inventory_movements (
  id         bigint generated always as identity primary key,
  store_id   uuid not null,
  variant_id uuid not null,
  delta      integer not null check (delta <> 0),
  qty_after  integer not null,
  reason     public.inventory_reason not null,
  ref        text,
  note       text check (char_length(note) <= 500),
  actor_id   uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  foreign key (variant_id, store_id) references public.product_variants (id, store_id) on delete cascade
);

create index inventory_movements_variant on public.inventory_movements (variant_id, created_at desc);
create index inventory_movements_store on public.inventory_movements (store_id, created_at desc);

-- Storefront visibility for catalogue children: the store is live and the product is active.
create function private.is_visible_product(p_product_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.products p
    join public.stores s on s.id = p.store_id
    where p.id = p_product_id and p.status = 'active' and s.status = 'live'
  )
$$;

-- ---------------------------------------------------------------------------------------------
-- Build pipeline and cost
-- ---------------------------------------------------------------------------------------------

create table public.build_jobs (
  id               text primary key,
  store_id         uuid references public.stores (id) on delete set null,
  created_by       uuid references auth.users (id) on delete set null,
  status           public.build_status not null default 'queued',
  -- sha256 of the token in the guest's cookie; lets an anonymous build be claimed after signup.
  claim_token_hash text,
  claim_expires_at timestamptz,
  run_id           text,
  -- The engine's JobRecord, stored whole so the pipeline code does not change shape.
  record           jsonb not null check (jsonb_typeof(record) = 'object'),
  error            text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create index build_jobs_store on public.build_jobs (store_id, created_at desc);
create index build_jobs_created_by on public.build_jobs (created_by, created_at desc);
create unique index build_jobs_claim_token on public.build_jobs (claim_token_hash) where claim_token_hash is not null;

create trigger build_jobs_touch before update on public.build_jobs
  for each row execute function private.touch_updated_at();

create table public.usage_ledger (
  id         bigint generated always as identity primary key,
  store_id   uuid references public.stores (id) on delete set null,
  job_id     text references public.build_jobs (id) on delete set null,
  provider   text not null check (provider in ('anthropic', 'rapidapi', 'apify', 'firecrawl', 'jina', 'other')),
  operation  text not null,
  units      numeric(14, 4) not null default 0,
  cost_usd   numeric(12, 6) not null default 0,
  meta       jsonb not null default '{}' check (jsonb_typeof(meta) = 'object'),
  created_at timestamptz not null default now()
);

create index usage_ledger_store on public.usage_ledger (store_id, created_at desc);
create index usage_ledger_job on public.usage_ledger (job_id);
create index usage_ledger_created on public.usage_ledger (created_at desc);

-- ---------------------------------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------------------------------

alter table public.profiles            enable row level security;
alter table public.stores              enable row level security;
alter table public.store_members       enable row level security;
alter table public.store_domains       enable row level security;
alter table public.store_settings      enable row level security;
alter table public.products            enable row level security;
alter table public.product_images      enable row level security;
alter table public.product_options     enable row level security;
alter table public.product_variants    enable row level security;
alter table public.categories          enable row level security;
alter table public.product_categories  enable row level security;
alter table public.collections         enable row level security;
alter table public.collection_products enable row level security;
alter table public.inventory_movements enable row level security;
alter table public.build_jobs          enable row level security;
alter table public.usage_ledger        enable row level security;

-- Profiles: your own row. platform_role is not in the column grant, so it cannot be self-promoted.
create policy profiles_select_own on public.profiles for select to authenticated
  using (id = (select auth.uid()) or private.is_platform_admin());
create policy profiles_update_own on public.profiles for update to authenticated
  using (id = (select auth.uid())) with check (id = (select auth.uid()));

-- Stores: members see theirs, shoppers see live ones. Created through create_store().
create policy stores_select on public.stores for select to anon, authenticated
  using (status = 'live' or private.has_store_role(id) or private.is_platform_admin());
create policy stores_update on public.stores for update to authenticated
  using (private.has_store_role(id, 'admin')) with check (private.has_store_role(id, 'admin'));

create policy store_members_select on public.store_members for select to authenticated
  using (private.has_store_role(store_id) or private.is_platform_admin());

create policy store_domains_select on public.store_domains for select to anon, authenticated
  using ((verified_at is not null and private.is_live_store(store_id)) or private.has_store_role(store_id));

create policy store_settings_select on public.store_settings for select to anon, authenticated
  using (private.is_live_store(store_id) or private.has_store_role(store_id));
create policy store_settings_update on public.store_settings for update to authenticated
  using (private.has_store_role(store_id, 'admin')) with check (private.has_store_role(store_id, 'admin'));

-- Catalogue: staff and up manage it; shoppers read active products of live stores.
create policy products_select on public.products for select to anon, authenticated
  using ((status = 'active' and private.is_live_store(store_id)) or private.has_store_role(store_id));
create policy products_insert on public.products for insert to authenticated
  with check (private.has_store_role(store_id));
create policy products_update on public.products for update to authenticated
  using (private.has_store_role(store_id)) with check (private.has_store_role(store_id));
create policy products_delete on public.products for delete to authenticated
  using (private.has_store_role(store_id, 'admin'));

create policy product_images_select on public.product_images for select to anon, authenticated
  using (private.is_visible_product(product_id) or private.has_store_role(store_id));
create policy product_images_write on public.product_images for all to authenticated
  using (private.has_store_role(store_id)) with check (private.has_store_role(store_id));

create policy product_options_select on public.product_options for select to anon, authenticated
  using (private.is_visible_product(product_id) or private.has_store_role(store_id));
create policy product_options_write on public.product_options for all to authenticated
  using (private.has_store_role(store_id)) with check (private.has_store_role(store_id));

create policy product_variants_select on public.product_variants for select to anon, authenticated
  using (private.is_visible_product(product_id) or private.has_store_role(store_id));
create policy product_variants_write on public.product_variants for all to authenticated
  using (private.has_store_role(store_id)) with check (private.has_store_role(store_id));

create policy categories_select on public.categories for select to anon, authenticated
  using (private.is_live_store(store_id) or private.has_store_role(store_id));
create policy categories_write on public.categories for all to authenticated
  using (private.has_store_role(store_id)) with check (private.has_store_role(store_id));

create policy product_categories_select on public.product_categories for select to anon, authenticated
  using (private.is_visible_product(product_id) or private.has_store_role(store_id));
create policy product_categories_write on public.product_categories for all to authenticated
  using (private.has_store_role(store_id)) with check (private.has_store_role(store_id));

create policy collections_select on public.collections for select to anon, authenticated
  using (private.is_live_store(store_id) or private.has_store_role(store_id));
create policy collections_write on public.collections for all to authenticated
  using (private.has_store_role(store_id)) with check (private.has_store_role(store_id));

create policy collection_products_select on public.collection_products for select to anon, authenticated
  using (private.is_visible_product(product_id) or private.has_store_role(store_id));
create policy collection_products_write on public.collection_products for all to authenticated
  using (private.has_store_role(store_id)) with check (private.has_store_role(store_id));

create policy inventory_movements_select on public.inventory_movements for select to authenticated
  using (private.has_store_role(store_id));

-- Jobs: whoever started them, and members of the store they built. Written only by the server.
create policy build_jobs_select on public.build_jobs for select to authenticated
  using (created_by = (select auth.uid()) or private.has_store_role(store_id) or private.is_platform_admin());

create policy usage_ledger_select on public.usage_ledger for select to authenticated
  using (private.has_store_role(store_id, 'admin') or private.is_platform_admin());

-- ---------------------------------------------------------------------------------------------
-- Column privileges
-- RLS decides which rows; these decide which columns a signed-in user may write at all.
-- ---------------------------------------------------------------------------------------------

revoke insert, update, delete, truncate on public.profiles from anon, authenticated;
grant update (display_name, phone, avatar_url) on public.profiles to authenticated;

-- status and verified_at change only through server code (publishing checks, admin actions).
revoke insert, update, delete, truncate on public.stores from anon, authenticated;
grant update (name, currency, locale) on public.stores to authenticated;

revoke insert, update, delete, truncate on public.store_members from anon, authenticated;
revoke insert, update, delete, truncate on public.store_domains from anon, authenticated;

revoke insert, update, delete, truncate on public.store_settings from anon, authenticated;
grant update (template_id, brand, theme, pages, seo, social, contact, policies, checkout)
  on public.store_settings to authenticated;

-- stock_qty moves only through adjust_stock() so every change lands in inventory_movements.
revoke update on public.product_variants from authenticated;
grant update (title, options, sku, price_cents, compare_at_cents, track_stock, allow_backorder,
              low_stock_threshold, weight_g, image_id, position)
  on public.product_variants to authenticated;

revoke insert, update, delete, truncate on public.inventory_movements from anon, authenticated;
revoke all on public.build_jobs from anon;
revoke insert, update, delete, truncate on public.build_jobs from authenticated;
revoke all on public.usage_ledger from anon;
revoke insert, update, delete, truncate on public.usage_ledger from authenticated;

-- Shoppers write nothing in the catalogue.
revoke insert, update, delete, truncate on
  public.products, public.product_images, public.product_options, public.product_variants,
  public.categories, public.product_categories, public.collections, public.collection_products
from anon;

-- The owner-only columns of stores stay hidden from shoppers.
revoke select on public.stores from anon;
grant select (id, slug, name, status, currency, locale) on public.stores to anon;

-- ---------------------------------------------------------------------------------------------
-- Functions callable through the Data API
-- ---------------------------------------------------------------------------------------------

-- Creates a store owned by the caller, with its settings row and default subdomain.
create function public.create_store(p_name text, p_slug text)
returns public.stores
language plpgsql security definer set search_path = '' as $$
declare
  v_user uuid := (select auth.uid());
  v_store public.stores;
begin
  if v_user is null then
    raise exception 'Sign in to create a store' using errcode = '42501';
  end if;
  if not private.is_valid_slug(p_slug) then
    raise exception 'Store address "%" must be 3-40 lowercase letters, numbers or hyphens', p_slug
      using errcode = '22023';
  end if;
  if private.is_reserved_slug(p_slug) then
    raise exception 'Store address "%" is reserved', p_slug using errcode = '22023';
  end if;

  insert into public.stores (slug, name, created_by)
  values (p_slug, btrim(p_name), v_user)
  returning * into v_store;

  insert into public.store_members (store_id, user_id, role) values (v_store.id, v_user, 'owner');
  insert into public.store_settings (store_id) values (v_store.id);

  return v_store;
exception
  when unique_violation then
    raise exception 'Store address "%" is already taken', p_slug using errcode = '23505';
end $$;

-- Changes a variant's stock by p_delta and records why. Returns the new quantity.
create function public.adjust_stock(p_variant_id uuid, p_delta integer, p_note text default null)
returns integer
language plpgsql security definer set search_path = '' as $$
declare
  v_variant public.product_variants;
begin
  if p_delta is null or p_delta = 0 then
    raise exception 'Stock change must not be zero' using errcode = '22023';
  end if;

  select * into v_variant from public.product_variants where id = p_variant_id for update;
  if not found or not private.has_store_role(v_variant.store_id) then
    raise exception 'Variant not found' using errcode = 'P0002';
  end if;

  update public.product_variants
     set stock_qty = stock_qty + p_delta
   where id = p_variant_id
  returning * into v_variant;

  insert into public.inventory_movements (store_id, variant_id, delta, qty_after, reason, note, actor_id)
  values (v_variant.store_id, v_variant.id, p_delta, v_variant.stock_qty, 'manual', p_note, (select auth.uid()));

  return v_variant.stock_qty;
end $$;

revoke execute on function public.create_store(text, text) from public, anon;
revoke execute on function public.adjust_stock(uuid, integer, text) from public, anon;
grant execute on function public.create_store(text, text) to authenticated, service_role;
grant execute on function public.adjust_stock(uuid, integer, text) to authenticated, service_role;

revoke execute on all functions in schema private from public;
grant execute on function
  private.has_store_role(uuid, public.store_role),
  private.is_live_store(uuid),
  private.is_visible_product(uuid),
  private.is_platform_admin(),
  private.is_valid_slug(text),
  private.is_reserved_slug(text)
to anon, authenticated, service_role;
