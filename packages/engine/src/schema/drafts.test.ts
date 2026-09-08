/**
 * Structured outputs reject a schema with more than 16 union-typed parameters:
 *   "Schemas contains too many parameters with type arrays or anyOf. This causes exponential
 *    compilation cost. Reduce the number of nullable or union-typed parameters (limit: 16)."
 *
 * That limit is invisible until a live call fails mid-job, so it is asserted here instead.
 * If one of these trips, express absence with a sentinel ("" / 0 / "keep") rather than nullable.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { AttachmentBatchDraftSchema, EnrichmentDraftSchema, ProductBatchDraftSchema, StoreDraftSchema } from "./drafts.js";

const UNION_LIMIT = 16;

/** Count schema nodes the API considers union-typed: an `anyOf`/`oneOf`, or `"type": [...]`. */
function countUnions(node: unknown, seen = new Set<unknown>()): number {
  if (!node || typeof node !== "object" || seen.has(node)) return 0;
  seen.add(node);
  if (Array.isArray(node)) return node.reduce<number>((n, child) => n + countUnions(child, seen), 0);
  const o = node as Record<string, unknown>;
  let count = 0;
  if (Array.isArray(o.anyOf) || Array.isArray(o.oneOf)) count += 1;
  if (Array.isArray(o.type)) count += 1;
  for (const [key, value] of Object.entries(o)) {
    if (key === "description" || key === "title") continue;
    count += countUnions(value, seen);
  }
  return count;
}

const SCHEMAS: Array<[string, z.ZodType]> = [
  ["StoreDraft", StoreDraftSchema],
  ["ProductBatchDraft", ProductBatchDraftSchema],
  ["EnrichmentDraft", EnrichmentDraftSchema],
  ["AttachmentBatchDraft", AttachmentBatchDraftSchema],
];

describe("draft schemas stay inside the structured-output limits", () => {
  for (const [name, schema] of SCHEMAS) {
    it(`${name} has at most ${UNION_LIMIT} union-typed parameters`, () => {
      const json = z.toJSONSchema(schema, { io: "output" });
      const unions = countUnions(json);
      expect(unions, `${name} would be rejected by the API with ${unions} union-typed parameters`).toBeLessThanOrEqual(UNION_LIMIT);
    });

    it(`${name} declares every property as required`, () => {
      const json = z.toJSONSchema(schema, { io: "output" }) as Record<string, unknown>;
      const problems: string[] = [];
      const walk = (node: unknown, path: string) => {
        if (!node || typeof node !== "object") return;
        if (Array.isArray(node)) return node.forEach((c, i) => walk(c, `${path}[${i}]`));
        const o = node as Record<string, unknown>;
        if (o.type === "object" && o.properties && typeof o.properties === "object") {
          const props = Object.keys(o.properties as object);
          const required = new Set((o.required as string[] | undefined) ?? []);
          for (const p of props) if (!required.has(p)) problems.push(`${path}.${p}`);
        }
        for (const [k, v] of Object.entries(o)) if (k !== "description") walk(v, `${path}.${k}`);
      };
      walk(json, name);
      expect(problems).toEqual([]);
    });
  }
});

describe("sentinel contract", () => {
  it("keeps 'keep' available on every enrichment enum so nothing is forced to change", () => {
    const json = JSON.stringify(z.toJSONSchema(EnrichmentDraftSchema, { io: "output" }));
    expect(json).toContain('"keep"');
  });

  it("accepts a fully-empty draft, which is what 'nothing found' looks like", () => {
    const empty = {
      brand: { tagline: "", description: "", story: "", tone: "" },
      theme: { preset: "keep", mode: "keep", primary: "", secondary: "", accent: "", background: "", surface: "", text: "", headingFont: "", bodyFont: "", radius: "keep", rationale: "" },
      home: { heroTitle: "", heroSubtitle: "", heroCta: "", announcement: "", featuredProductIds: [], sections: [], usps: [] },
      productCopy: [],
      categories: [],
      faq: [],
      seo: { title: "", description: "", keywords: [] },
      templateChoice: { templateId: "", reason: "" },
      warnings: [],
    };
    expect(EnrichmentDraftSchema.safeParse(empty).success).toBe(true);
  });
});
