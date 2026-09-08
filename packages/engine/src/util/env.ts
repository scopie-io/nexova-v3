import { promises as fs } from "node:fs";
import path from "node:path";

/** Minimal .env loader (no dependency). Existing process env always wins. */
export async function loadDotEnv(dir = process.cwd(), file = ".env"): Promise<Record<string, string>> {
  const loaded: Record<string, string> = {};
  let raw = "";
  try {
    raw = await fs.readFile(path.join(dir, file), "utf8");
  } catch {
    return loaded;
  }
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)?\s*$/);
    if (!m) continue;
    let value = (m[2] ?? "").trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    else value = value.replace(/\s+#.*$/, "");
    if (process.env[m[1]] === undefined) process.env[m[1]] = value;
    loaded[m[1]] = value;
  }
  return loaded;
}
