-- Row level security checks for the SaaS core migration.
-- Runs against a database built from supabase/tests/stub-auth.sql plus every migration
-- (see scripts/test-db.sh). Each check raises on failure, so psql -v ON_ERROR_STOP=1 exits non-zero.

\set QUIET on
\pset tuples_only on
\pset format unaligned
set client_min_messages = notice;

-- Act as a signed-in user (or anon when p_user is null) for the rest of the transaction.
create or replace function pg_temp.act_as(p_user uuid) returns void language plpgsql as $$
begin
  if p_user is null then
    perform set_config('request.jwt.claims', '', true);
    execute 'set local role anon';
  else
    perform set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
    execute 'set local role authenticated';
  end if;
end $$;

create or replace function pg_temp.expect(p_ok boolean, p_what text) returns void language plpgsql as $$
begin
  if not coalesce(p_ok, false) then
    raise exception 'FAILED: %', p_what;
  end if;
  raise notice 'ok  %', p_what;
end $$;

-- Runs p_sql and passes only if it raises. insufficient_privilege and RLS violations both count.
create or replace function pg_temp.expect_error(p_sql text, p_what text) returns void language plpgsql as $$
begin
  begin
    execute p_sql;
  exception when others then
    raise notice 'ok  % (%)', p_what, sqlerrm;
    return;
  end;
  raise exception 'FAILED: % (statement succeeded)', p_what;
end $$;

-- Fixtures, as the database owner.
insert into auth.users (id, email, raw_user_meta_data) values
  ('00000000-0000-0000-0000-00000000000a', 'owner@example.com', '{"display_name":"Aina"}'),
  ('00000000-0000-0000-0000-00000000000b', 'other@example.com', '{}'),
  ('00000000-0000-0000-0000-00000000000c', 'staff@example.com', '{}');

select pg_temp.expect((select display_name from public.profiles where id = '00000000-0000-0000-0000-00000000000a') = 'Aina',
  'signup trigger creates a profile with the display name');

\set owner '''00000000-0000-0000-0000-00000000000a'''
\set other '''00000000-0000-0000-0000-00000000000b'''
\set staff '''00000000-0000-0000-0000-00000000000c'''

-- ---- create_store --------------------------------------------------------------------------
begin;
select pg_temp.act_as(null);
select pg_temp.expect_error($$select public.create_store('Nope', 'nope-store')$$, 'anon cannot create a store');
rollback;

begin;
select pg_temp.act_as(:owner);
select pg_temp.expect((select slug from public.create_store('Goli Nutrition', 'goli')) = 'goli', 'owner creates a store');
select pg_temp.expect_error($$select public.create_store('Www', 'www')$$, 'reserved slug is refused');
select pg_temp.expect_error($$select public.create_store('Bad', 'Bad_Slug')$$, 'invalid slug is refused');
select pg_temp.expect((select count(*) from public.store_members where role = 'owner') = 1, 'creator becomes the owner');
select pg_temp.expect((select count(*) from public.store_settings) = 1, 'settings row is created');
select pg_temp.expect_error($$update public.stores set status = 'live'$$, 'owner cannot publish by updating status directly');
select pg_temp.expect_error($$insert into public.store_members (store_id, user_id, role)
  select id, '00000000-0000-0000-0000-00000000000b', 'admin' from public.stores$$, 'owner cannot insert members directly');
commit;

begin;
select pg_temp.act_as(:other);
select pg_temp.expect_error($$select public.create_store('Goli Copy', 'goli')$$, 'taken slug is refused');
rollback;

-- Catalogue fixtures and a staff member, as the database owner.
insert into public.store_members (store_id, user_id, role)
  select id, '00000000-0000-0000-0000-00000000000c', 'staff' from public.stores where slug = 'goli';

begin;
select pg_temp.act_as(:owner);
insert into public.products (store_id, slug, title, status)
  select id, 'apple-cider-gummies', 'Apple Cider Vinegar Gummies', 'active' from public.stores where slug = 'goli';
insert into public.products (store_id, slug, title, status)
  select id, 'draft-thing', 'Unreleased', 'draft' from public.stores where slug = 'goli';
insert into public.product_variants (store_id, product_id, price_cents, stock_qty)
  select store_id, id, 5990, 0 from public.products;
select pg_temp.expect((select count(*) from public.products) = 2, 'owner sees both products');
select pg_temp.expect((select public.adjust_stock(v.id, 25, 'first delivery') from public.product_variants v
  join public.products p on p.id = v.product_id where p.slug = 'apple-cider-gummies') = 25, 'adjust_stock returns the new quantity');
select pg_temp.expect((select count(*) from public.inventory_movements) = 1, 'stock change is recorded');
select pg_temp.expect_error($$update public.product_variants set stock_qty = 999$$, 'stock cannot be set directly');
with u as (update public.product_variants set price_cents = 6490 returning 1)
  select pg_temp.expect(count(*) = 2, 'owner can reprice variants') from u;
select pg_temp.expect_error($$update public.profiles set platform_role = 'admin' where id = '00000000-0000-0000-0000-00000000000a'$$,
  'user cannot promote themselves to platform admin');
commit;

-- ---- isolation ------------------------------------------------------------------------------
begin;
select pg_temp.act_as(:other);
select pg_temp.expect((select count(*) from public.stores) = 0, 'outsider cannot see a draft store');
select pg_temp.expect((select count(*) from public.products) = 0, 'outsider cannot see its products');
select pg_temp.expect((select count(*) from public.store_settings) = 0, 'outsider cannot see its settings');
with u as (update public.products set title = 'hacked' returning 1)
  select pg_temp.expect(count(*) = 0, 'outsider updates touch no rows') from u;
select pg_temp.expect_error($$insert into public.products (store_id, slug, title)
  values ((select id from public.stores limit 1), 'planted', 'Planted')$$, 'outsider cannot insert products');
rollback;

-- The outsider cannot see the variant, so look its id up first as the database owner.
select id as goli_variant from public.product_variants limit 1 \gset
begin;
select pg_temp.act_as(:other);
select pg_temp.expect_error(format('select public.adjust_stock(%L, 5)', :'goli_variant'), 'outsider cannot adjust stock by id');
rollback;

-- Staff: manage catalogue, not settings, not deletes.
begin;
select pg_temp.act_as(:staff);
select pg_temp.expect((select count(*) from public.products) = 2, 'staff sees the catalogue');
with u as (update public.products set featured = true returning 1)
  select pg_temp.expect(count(*) = 2, 'staff can edit products') from u;
with u as (update public.store_settings set theme = '{"mode":"dark"}' returning 1)
  select pg_temp.expect(count(*) = 0, 'staff cannot edit store settings') from u;
with u as (delete from public.products returning 1)
  select pg_temp.expect(count(*) = 0, 'staff cannot delete products') from u;
select pg_temp.expect((select count(*) from public.usage_ledger) = 0, 'staff cannot read the cost ledger');
rollback;

-- ---- storefront visibility ------------------------------------------------------------------
begin;
select pg_temp.act_as(null);
select pg_temp.expect((select count(*) from public.stores) = 0, 'shoppers cannot see a draft store');
select pg_temp.expect_error($$select created_by from public.stores$$, 'shoppers cannot read owner columns');
rollback;

update public.stores set status = 'live' where slug = 'goli';
insert into public.store_domains (store_id, hostname, kind, is_primary, verified_at)
  select id, 'goli.nexova.store', 'subdomain', true, now() from public.stores where slug = 'goli';

begin;
select pg_temp.act_as(null);
select pg_temp.expect((select count(*) from public.stores) = 1, 'shoppers see a live store');
select pg_temp.expect((select count(*) from public.store_domains where hostname = 'goli.nexova.store') = 1, 'shoppers resolve a verified domain');
select pg_temp.expect((select count(*) from public.products) = 1, 'shoppers see only active products');
select pg_temp.expect((select count(*) from public.product_variants) = 1, 'shoppers see only variants of active products');
select pg_temp.expect((select count(*) from public.inventory_movements) = 0, 'shoppers cannot see stock history');
select pg_temp.expect_error($$update public.products set title = 'x'$$, 'shoppers cannot edit products');
rollback;

-- ---- integrity ------------------------------------------------------------------------------
insert into auth.users (id) values ('00000000-0000-0000-0000-00000000000d');
begin;
select pg_temp.act_as('00000000-0000-0000-0000-00000000000d');
select public.create_store('Second Shop', 'second-shop');
commit;

select pg_temp.expect_error($$insert into public.product_variants (store_id, product_id, price_cents)
  select s.id, p.id, 100 from public.stores s, public.products p
  where s.slug = 'second-shop' and p.slug = 'apple-cider-gummies'$$,
  'a variant cannot point at another store''s product');

\echo 'rls.sql: all checks passed'
