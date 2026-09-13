import { promises as fs } from "node:fs";
import path from "node:path";

export async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

export async function ensureDir(p: string): Promise<void> {
  await fs.mkdir(p, { recursive: true });
}

export async function readJson<T = unknown>(p: string): Promise<T> {
  const raw = await fs.readFile(p, "utf8");
  return JSON.parse(raw) as T;
}

export async function readJsonOrNull<T = unknown>(p: string): Promise<T | null> {
  try {
    return await readJson<T>(p);
  } catch {
    return null;
  }
}

/** Atomic JSON write: write to a temp file in the same dir, then rename. */
export async function writeJson(p: string, data: unknown, pretty = true): Promise<void> {
  await ensureDir(path.dirname(p));
  const tmp = `${p}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  await fs.writeFile(tmp, pretty ? JSON.stringify(data, null, 2) : JSON.stringify(data), "utf8");
  await renameOverOpen(tmp, p);
}

/**
 * On Windows, replacing a file that another handle has open at that instant (the API reading
 * job.json while the pipeline saves it) fails with EPERM/EBUSY. The window is a few ms, so retry
 * briefly instead of failing the whole job; any other error, or a persistent one, still throws.
 */
async function renameOverOpen(from: string, to: string, attempts = 12): Promise<void> {
  for (let i = 0; ; i++) {
    try {
      await fs.rename(from, to);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if ((code !== "EPERM" && code !== "EBUSY" && code !== "EACCES") || i >= attempts - 1) {
        await fs.rm(from, { force: true }).catch(() => {});
        throw err;
      }
      await new Promise((r) => setTimeout(r, 10 * (i + 1)));
    }
  }
}

export async function writeText(p: string, text: string): Promise<void> {
  await ensureDir(path.dirname(p));
  await fs.writeFile(p, text, "utf8");
}

export async function appendLine(p: string, line: string): Promise<void> {
  await ensureDir(path.dirname(p));
  await fs.appendFile(p, line.endsWith("\n") ? line : line + "\n", "utf8");
}

export async function rmrf(p: string): Promise<void> {
  await fs.rm(p, { recursive: true, force: true, maxRetries: 3 });
}

export interface CopyDirOptions {
  /** Directory or file names to skip at any depth. */
  ignore?: string[];
  /** Skip symlinks / junctions (default true). */
  skipSymlinks?: boolean;
}

/** Recursive copy that skips node_modules, dist and VCS folders by default. */
export async function copyDir(src: string, dest: string, opts: CopyDirOptions = {}): Promise<number> {
  const ignore = new Set(opts.ignore ?? ["node_modules", "dist", ".git", ".DS_Store", ".vite", ".cache"]);
  const skipSymlinks = opts.skipSymlinks ?? true;
  let count = 0;
  await ensureDir(dest);
  const entries = await fs.readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    if (ignore.has(entry.name)) continue;
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isSymbolicLink()) {
      if (skipSymlinks) continue;
    }
    if (entry.isDirectory()) {
      count += await copyDir(s, d, opts);
    } else if (entry.isFile()) {
      await fs.copyFile(s, d);
      count++;
    }
  }
  return count;
}

/** Create a directory junction (Windows) / symlink (POSIX) so generated sites reuse a template's node_modules. */
export async function linkDir(target: string, linkPath: string): Promise<void> {
  if (await exists(linkPath)) return;
  await ensureDir(path.dirname(linkPath));
  const type = process.platform === "win32" ? "junction" : "dir";
  await fs.symlink(target, linkPath, type);
}

export async function listDirs(p: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(p, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }
}

export async function fileSize(p: string): Promise<number> {
  try {
    return (await fs.stat(p)).size;
  } catch {
    return 0;
  }
}
