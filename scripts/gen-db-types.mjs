#!/usr/bin/env node
// Writes packages/db/src/database.types.ts in the same shape as `supabase gen types typescript`,
// by introspecting a Postgres database built by scripts/test-db.sh. Needs psql, not Docker.
//
//   PGHOST=127.0.0.1 PGPORT=5432 PGUSER=postgres node scripts/gen-db-types.mjs [database]
//
// Once the Supabase project is linked, `supabase gen types typescript --project-id <ref>` gives the
// same result from the live schema; both must agree, and CI checks this file against the migrations.
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const database = process.argv[2] ?? process.env.NEXOVA_TEST_DB ?? "nexova_test";
const out = fileURLToPath(new URL("../packages/db/src/database.types.ts", import.meta.url));

const introspect = String.raw`
with
tables as (
  select c.oid, c.relname as name
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind in ('r', 'p')
),
columns as (
  select t.name as table_name, a.attname as name, a.attnum,
         bt.typname as base_type, (bt.typcategory = 'E') as is_enum, (ty.typcategory = 'A') as is_array,
         not a.attnotnull as nullable,
         (a.atthasdef or a.attidentity <> '') as has_default,
         (a.attidentity = 'a' or a.attgenerated <> '') as always_generated
  from tables t
  join pg_attribute a on a.attrelid = t.oid and a.attnum > 0 and not a.attisdropped
  join pg_type ty on ty.oid = a.atttypid
  join pg_type bt on bt.oid = case when ty.typcategory = 'A' then ty.typelem else ty.oid end
),
fks as (
  select t.name as table_name, con.conname as name,
         (select array_agg(a.attname order by k.ord) from unnest(con.conkey) with ordinality k(attnum, ord)
            join pg_attribute a on a.attrelid = con.conrelid and a.attnum = k.attnum) as columns,
         rc.relname as referenced_relation,
         (select array_agg(a.attname order by k.ord) from unnest(con.confkey) with ordinality k(attnum, ord)
            join pg_attribute a on a.attrelid = con.confrelid and a.attnum = k.attnum) as referenced_columns,
         exists (
           select 1 from pg_index i
           where i.indrelid = con.conrelid and i.indisunique and i.indpred is null
             and (select array_agg(x order by x) from unnest(i.indkey::int2[]) x) =
                 (select array_agg(x order by x) from unnest(con.conkey) x)
         ) as one_to_one
  from tables t
  join pg_constraint con on con.conrelid = t.oid and con.contype = 'f'
  join pg_class rc on rc.oid = con.confrelid
  join pg_namespace rn on rn.oid = rc.relnamespace and rn.nspname = 'public'
),
enums as (
  select ty.typname as name, array_agg(e.enumlabel order by e.enumsortorder) as labels
  from pg_type ty join pg_namespace n on n.oid = ty.typnamespace and n.nspname = 'public'
  join pg_enum e on e.enumtypid = ty.oid
  group by ty.typname
),
functions as (
  select p.proname as name,
         coalesce(p.proargnames, '{}') as arg_names,
         (select array_agg(bt.typname order by k.ord)
            from unnest(p.proargtypes::oid[]) with ordinality k(typ, ord) join pg_type bt on bt.oid = k.typ) as arg_types,
         p.pronargdefaults as n_defaults,
         rt.typname as return_type, rt.typtype = 'c' as returns_row, p.proretset as returns_set
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace and n.nspname = 'public'
  join pg_type rt on rt.oid = p.prorettype
  where p.prokind = 'f' and rt.typname <> 'trigger'
)
select json_build_object(
  'tables', (select coalesce(json_agg(json_build_object('name', t.name,
      'columns', (select json_agg(c order by c.name) from columns c where c.table_name = t.name),
      'fks', (select coalesce(json_agg(f order by f.name), '[]') from fks f where f.table_name = t.name))
    order by t.name), '[]') from tables t),
  'enums', (select coalesce(json_agg(e order by e.name), '[]') from enums e),
  'functions', (select coalesce(json_agg(f order by f.name), '[]') from functions f)
)`;

const schema = JSON.parse(
  execFileSync("psql", ["-X", "-A", "-t", "-v", "ON_ERROR_STOP=1", "-d", database, "-c", introspect], {
    encoding: "utf8",
  }),
);

const SCALARS = {
  uuid: "string", text: "string", varchar: "string", bpchar: "string", citext: "string", name: "string",
  timestamptz: "string", timestamp: "string", date: "string", time: "string", interval: "string", inet: "string",
  int2: "number", int4: "number", int8: "number", float4: "number", float8: "number", numeric: "number",
  bool: "boolean", json: "Json", jsonb: "Json", bytea: "string",
};

const enumNames = new Set(schema.enums.map((e) => e.name));

function tsType(baseType, isArray = false) {
  const base = enumNames.has(baseType)
    ? `Database["public"]["Enums"]["${baseType}"]`
    : SCALARS[baseType] ?? "unknown";
  return isArray ? `${base}[]` : base;
}

const ind = (n) => "  ".repeat(n);

function rowColumns(columns, mode, depth) {
  return columns
    .map((c) => {
      const type = tsType(c.base_type, c.is_array) + (c.nullable ? " | null" : "");
      if (mode === "Row") return `${ind(depth)}${c.name}: ${type}`;
      if (c.always_generated) return `${ind(depth)}${c.name}?: never`;
      const optional = mode === "Update" || c.nullable || c.has_default;
      return `${ind(depth)}${c.name}${optional ? "?" : ""}: ${type}`;
    })
    .join("\n");
}

function tableBlock(table) {
  const d = 4;
  const rels = table.fks
    .map(
      (f) => `${ind(d + 1)}{
${ind(d + 2)}foreignKeyName: "${f.name}"
${ind(d + 2)}columns: [${f.columns.map((c) => `"${c}"`).join(", ")}]
${ind(d + 2)}isOneToOne: ${f.one_to_one}
${ind(d + 2)}referencedRelation: "${f.referenced_relation}"
${ind(d + 2)}referencedColumns: [${f.referenced_columns.map((c) => `"${c}"`).join(", ")}]
${ind(d + 1)}},`,
    )
    .join("\n");
  return `${ind(d - 1)}${table.name}: {
${ind(d)}Row: {
${rowColumns(table.columns, "Row", d + 1)}
${ind(d)}}
${ind(d)}Insert: {
${rowColumns(table.columns, "Insert", d + 1)}
${ind(d)}}
${ind(d)}Update: {
${rowColumns(table.columns, "Update", d + 1)}
${ind(d)}}
${ind(d)}Relationships: [${rels ? `\n${rels}\n${ind(d)}` : ""}]
${ind(d - 1)}}`;
}

function functionBlock(fn) {
  const d = 4;
  const firstDefault = fn.arg_types.length - fn.n_defaults;
  const args = (fn.arg_types ?? [])
    .map((t, i) => `${ind(d + 1)}${fn.arg_names[i]}${i >= firstDefault ? "?" : ""}: ${tsType(t)}`)
    .join("\n");
  let returns;
  let setof = "";
  if (fn.returns_row) {
    const table = schema.tables.find((t) => t.name === fn.return_type);
    returns = `{\n${rowColumns(table.columns, "Row", d + 1)}\n${ind(d)}}`;
    // Lets supabase-js chain .select() on an rpc that returns table rows.
    setof = `\n${ind(d)}SetofOptions: {
${ind(d + 1)}from: "*"
${ind(d + 1)}to: "${fn.return_type}"
${ind(d + 1)}isOneToOne: ${!fn.returns_set}
${ind(d + 1)}isSetofReturn: ${fn.returns_set}
${ind(d)}}`;
  } else {
    returns = tsType(fn.return_type) + (fn.returns_set ? "[]" : "");
  }
  return `${ind(d - 1)}${fn.name}: {
${ind(d)}Args: ${args ? `{\n${args}\n${ind(d)}}` : "never"}
${ind(d)}Returns: ${returns}${setof}
${ind(d - 1)}}`;
}

const never = "{ [_ in never]: never }";
const enumsBlock = schema.enums.length
  ? `{\n${schema.enums.map((e) => `${ind(3)}${e.name}: ${e.labels.map((l) => `"${l}"`).join(" | ")}`).join("\n")}\n${ind(2)}}`
  : never;
const constantsBlock = schema.enums
  .map((e) => `${ind(3)}${e.name}: [${e.labels.map((l) => `"${l}"`).join(", ")}],`)
  .join("\n");

const source = `// Generated by scripts/gen-db-types.mjs from supabase/migrations. Do not edit by hand.

export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  public: {
    Tables: {
${schema.tables.map(tableBlock).join("\n")}
    }
    Views: ${never}
    Functions: ${schema.functions.length ? `{\n${schema.functions.map(functionBlock).join("\n")}\n${ind(2)}}` : never}
    Enums: ${enumsBlock}
    CompositeTypes: ${never}
  }
}

type PublicSchema = Database["public"]

export type Tables<T extends keyof PublicSchema["Tables"]> = PublicSchema["Tables"][T]["Row"]
export type TablesInsert<T extends keyof PublicSchema["Tables"]> = PublicSchema["Tables"][T]["Insert"]
export type TablesUpdate<T extends keyof PublicSchema["Tables"]> = PublicSchema["Tables"][T]["Update"]
export type Enums<T extends keyof PublicSchema["Enums"]> = PublicSchema["Enums"][T]

export const Constants = {
  public: {
    Enums: {
${constantsBlock}
    },
  },
} as const
`;

writeFileSync(out, source);
console.log(`wrote ${out}: ${schema.tables.length} tables, ${schema.enums.length} enums, ${schema.functions.length} functions`);
