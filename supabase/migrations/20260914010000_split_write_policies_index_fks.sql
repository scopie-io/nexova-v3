-- Follow-up to saas_core, from the Supabase advisors on the live project.
--
-- 1. The catalogue "_write" policies were FOR ALL, so for SELECT they overlapped the "_select"
--    policies and Postgres evaluated both on every read. Split them into insert/update/delete.
-- 2. Index every foreign key, including the composite (parent_id, store_id) ones, so cascading
--    deletes and joins from the parent do not scan the child table.

-- ---- 1. Policies ------------------------------------------------------------------------------

do $$
declare
  t text;
begin
  foreach t in array array[
    'product_images', 'product_options', 'product_variants', 'categories',
    'product_categories', 'collections', 'collection_products'
  ] loop
    execute format('drop policy %I on public.%I', t || '_write', t);
    execute format(
      'create policy %I on public.%I for insert to authenticated with check (private.has_store_role(store_id))',
      t || '_insert', t);
    execute format(
      'create policy %I on public.%I for update to authenticated using (private.has_store_role(store_id)) with check (private.has_store_role(store_id))',
      t || '_update', t);
    execute format(
      'create policy %I on public.%I for delete to authenticated using (private.has_store_role(store_id))',
      t || '_delete', t);
  end loop;
end $$;

-- ---- 2. Foreign key indexes ------------------------------------------------------------------
-- Where an ordering index already led with the parent id, widen it rather than add a second one.

drop index public.product_images_product;
create index product_images_product on public.product_images (product_id, store_id, position);

create index product_options_product on public.product_options (product_id, store_id);

drop index public.product_variants_product;
create index product_variants_product on public.product_variants (product_id, store_id, position);
create index product_variants_image on public.product_variants (image_id) where image_id is not null;

drop index public.product_categories_category;
create index product_categories_category on public.product_categories (category_id, store_id, position);
create index product_categories_product on public.product_categories (product_id, store_id);

create index collection_products_collection on public.collection_products (collection_id, store_id, position);
drop index public.collection_products_product;
create index collection_products_product on public.collection_products (product_id, store_id);

drop index public.inventory_movements_variant;
create index inventory_movements_variant on public.inventory_movements (variant_id, store_id, created_at desc);
create index inventory_movements_actor on public.inventory_movements (actor_id) where actor_id is not null;

create index stores_created_by on public.stores (created_by) where created_by is not null;
