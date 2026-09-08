/**
 * Template manifest: `nexova.template.json` at the root of every template folder.
 * See docs/TEMPLATE_CONTRACT.md.
 */
import { z } from "zod";

export const TemplateManifestSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/, "id must be kebab-case"),
  name: z.string(),
  version: z.string().default("1.0.0"),
  description: z.string().default(""),
  style: z
    .object({
      tags: z.array(z.string()).default([]),
      mode: z.enum(["light", "dark", "both"]).default("both"),
      preset: z.string().nullable().default(null),
    })
    .prefault({}),
  industries: z.array(z.string()).default([]),
  features: z
    .object({
      variants: z.boolean().default(true),
      collections: z.boolean().default(true),
      reviews: z.boolean().default(true),
      blog: z.boolean().default(false),
      search: z.boolean().default(true),
      cart: z.boolean().default(true),
      whatsappCheckout: z.boolean().default(true),
    })
    .prefault({}),
  entry: z
    .object({
      dataFile: z.string().default("src/nexova/store.json"),
      themeFile: z.string().default("src/nexova/theme.css"),
      publicDir: z.string().default("public"),
    })
    .prefault({}),
  build: z
    .object({
      install: z.string().default("npm install --no-audit --no-fund"),
      build: z.string().default("npm run build"),
      outDir: z.string().default("dist"),
      dev: z.string().default("npm run dev"),
      basePathEnv: z.string().default("NEXOVA_BASE_PATH"),
    })
    .prefault({}),
  preview: z.string().nullable().default(null),
  minProducts: z.number().int().default(1),
  maxProducts: z.number().int().nullable().default(null),
});
export type TemplateManifest = z.infer<typeof TemplateManifestSchema>;

export interface TemplateEntry {
  manifest: TemplateManifest;
  dir: string;
}
