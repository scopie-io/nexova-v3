#!/usr/bin/env node
/**
 * Vercel builds on x64 Linux, but the Workflow SDK runs step functions on arm64 Linux. sharp is a
 * native module, so the step function needs the arm64 build next to the x64 one. Installing with
 * `--cpu=arm64` in place would swap every other platform-specific optional dependency too (it
 * broke TypeScript's native binary), so the arm64 packages are installed into a scratch folder and
 * only those are copied into node_modules/@img.
 *
 *   node scripts/add-sharp-arm64.mjs
 */
import { execSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sharpPkg = JSON.parse(await fs.readFile(path.join(root, "node_modules", "sharp", "package.json"), "utf8"));
const wanted = Object.entries(sharpPkg.optionalDependencies ?? {}).filter(([name]) => name === "@img/sharp-linux-arm64" || name === "@img/sharp-libvips-linux-arm64");
if (!wanted.length) {
  console.log("sharp has no linux-arm64 optional dependencies; nothing to do");
  process.exit(0);
}
const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "sharp-arm64-"));
await fs.writeFile(path.join(scratch, "package.json"), JSON.stringify({ name: "sharp-arm64-scratch", private: true }));
const specs = wanted.map(([name, version]) => `${name}@${version}`).join(" ");
console.log(`installing ${specs} for linux/arm64 into ${scratch}`);
execSync(`npm install --no-audit --no-fund --no-package-lock --include=optional --os=linux --cpu=arm64 ${specs}`, { cwd: scratch, stdio: "inherit" });
const dest = path.join(root, "node_modules", "@img");
await fs.mkdir(dest, { recursive: true });
for (const [name] of wanted) {
  const short = name.split("/")[1];
  await fs.rm(path.join(dest, short), { recursive: true, force: true });
  await fs.cp(path.join(scratch, "node_modules", "@img", short), path.join(dest, short), { recursive: true });
  console.log(`added node_modules/@img/${short}`);
}
await fs.rm(scratch, { recursive: true, force: true });
