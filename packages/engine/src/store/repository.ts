/**
 * StoreRepository: the source of truth for generated stores (stores/<slug>/store.json).
 * This is the seam the future CMS builds on: edit the spec, then rebuild.
 */
import path from "node:path";
import type { EngineConfig } from "../config.js";
import { parseStoreSpec, type Product, type StoreSpec } from "../schema/store-spec.js";
import { exists, listDirs, readJsonOrNull, writeJson } from "../util/fsx.js";
import { slugify, uniqueSlug } from "../util/ids.js";

export interface StoreMeta {
  slug: string;
  name: string;
  templateId: string | null;
  siteUrl: string | null;
  jobId: string | null;
  builtAt: string | null;
  updatedAt: string;
  products: number;
  deployProvider: string | null;
}

export class StoreRepository {
  constructor(private readonly config: EngineConfig) {}

  dir(slug: string): string {
    return path.join(this.config.storesDir, slug);
  }

  private specPath(slug: string): string {
    return path.join(this.dir(slug), "store.json");
  }

  private metaPath(slug: string): string {
    return path.join(this.dir(slug), "store.meta.json");
  }

  async list(): Promise<StoreMeta[]> {
    const out: StoreMeta[] = [];
    for (const slug of await listDirs(this.config.storesDir)) {
      const meta = await this.getMeta(slug);
      if (meta) out.push(meta);
    }
    return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async exists(slug: string): Promise<boolean> {
    return exists(this.specPath(slug));
  }

  async getSpec(slug: string): Promise<StoreSpec | null> {
    if (!/^[a-z0-9-]+$/.test(slug)) return null;
    const raw = await readJsonOrNull(this.specPath(slug));
    if (!raw) return null;
    const parsed = parseStoreSpec(raw);
    return parsed;
  }

  async saveSpec(spec: StoreSpec): Promise<void> {
    spec.meta.updatedAt = new Date().toISOString();
    await writeJson(this.specPath(spec.slug), spec);
    const meta = (await this.getMeta(spec.slug)) ?? { slug: spec.slug, name: spec.brand.name, templateId: spec.template.id, siteUrl: null, jobId: null, builtAt: null, updatedAt: spec.meta.updatedAt, products: spec.catalog.products.length, deployProvider: null };
    meta.name = spec.brand.name;
    meta.templateId = spec.template.id ?? meta.templateId;
    meta.products = spec.catalog.products.length;
    meta.updatedAt = spec.meta.updatedAt;
    await writeJson(this.metaPath(spec.slug), meta);
  }

  async getMeta(slug: string): Promise<StoreMeta | null> {
    return readJsonOrNull<StoreMeta>(this.metaPath(slug));
  }

  async updateMeta(slug: string, patch: Partial<StoreMeta>): Promise<StoreMeta> {
    const current = (await this.getMeta(slug)) ?? { slug, name: slug, templateId: null, siteUrl: null, jobId: null, builtAt: null, updatedAt: new Date().toISOString(), products: 0, deployProvider: null };
    const next = { ...current, ...patch, updatedAt: new Date().toISOString() };
    await writeJson(this.metaPath(slug), next);
    return next;
  }

  /** Reserve a slug that is not used by another store. */
  async reserveSlug(preferred: string | null, brandName: string): Promise<string> {
    const base = slugify(preferred || brandName, "store");
    // An explicitly requested slug is honored even if it exists (the merchant is regenerating that store).
    if (preferred) return base;
    const taken = new Set(await listDirs(this.config.storesDir));
    return uniqueSlug(base, taken);
  }

  /** Apply a validated transformation to a store spec (CMS edits, inventory changes). */
  async updateSpec(slug: string, updater: (spec: StoreSpec) => StoreSpec | void): Promise<StoreSpec> {
    const spec = await this.getSpec(slug);
    if (!spec) throw new Error(`store ${slug} not found`);
    const result = updater(spec) ?? spec;
    const validated = parseStoreSpec(result);
    await this.saveSpec(validated);
    return validated;
  }

  async patchProduct(slug: string, productId: string, patch: Partial<Product>): Promise<StoreSpec> {
    return this.updateSpec(slug, (spec) => {
      const p = spec.catalog.products.find((x) => x.id === productId);
      if (!p) throw new Error(`product ${productId} not found in ${slug}`);
      Object.assign(p, patch, { id: p.id, slug: p.slug });
    });
  }

  async upsertProduct(slug: string, product: Partial<Product> & { title: string }): Promise<StoreSpec> {
    return this.updateSpec(slug, (spec) => {
      const existing = product.id ? spec.catalog.products.find((x) => x.id === product.id) : null;
      if (existing) {
        Object.assign(existing, product, { id: existing.id, slug: existing.slug });
        return;
      }
      const taken = new Set(spec.catalog.products.map((p) => p.slug));
      const pslug = uniqueSlug(slugify(product.title, "product"), taken);
      spec.catalog.products.push(parseStoreSpec({ ...spec, catalog: { ...spec.catalog, products: [{ ...product, id: pslug, slug: pslug, price: product.price ?? { amount: 0, currency: spec.commerce.currency } }] } }).catalog.products[0]);
    });
  }

  async removeProduct(slug: string, productId: string): Promise<StoreSpec> {
    return this.updateSpec(slug, (spec) => {
      spec.catalog.products = spec.catalog.products.filter((p) => p.id !== productId);
      spec.pages.home.featuredProductIds = spec.pages.home.featuredProductIds.filter((id) => id !== productId);
    });
  }
}
