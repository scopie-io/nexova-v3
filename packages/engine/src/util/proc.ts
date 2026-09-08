import { spawn } from "node:child_process";
import type { Logger } from "./log.js";

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
  durationMs: number;
}

export interface RunOptions {
  cwd: string;
  env?: Record<string, string | undefined>;
  log?: Logger;
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Called with each line of output (stdout + stderr). */
  onLine?: (line: string) => void;
}

/** Run a shell command (npm etc.) with bounded output capture. Resolves even on non-zero exit. */
export function runCommand(command: string, opts: RunOptions): Promise<RunResult> {
  const started = Date.now();
  return new Promise((resolve) => {
    const child = spawn(command, {
      cwd: opts.cwd,
      env: { ...process.env, ...(opts.env ?? {}), FORCE_COLOR: "0", CI: "1" },
      shell: true,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const cap = (s: string) => (s.length > 200_000 ? s.slice(-200_000) : s);
    const handle = (chunk: Buffer, isErr: boolean) => {
      const text = chunk.toString("utf8");
      if (isErr) stderr = cap(stderr + text);
      else stdout = cap(stdout + text);
      if (opts.onLine) for (const line of text.split(/\r?\n/)) if (line.trim()) opts.onLine(line);
    };
    child.stdout?.on("data", (c: Buffer) => handle(c, false));
    child.stderr?.on("data", (c: Buffer) => handle(c, true));
    const timer = opts.timeoutMs ? setTimeout(() => child.kill(), opts.timeoutMs) : null;
    const onAbort = () => child.kill();
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    child.on("error", (err) => {
      if (timer) clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      resolve({ code: -1, stdout, stderr: stderr + "\n" + err.message, durationMs: Date.now() - started });
    });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      resolve({ code: code ?? -1, stdout, stderr, durationMs: Date.now() - started });
    });
  });
}

export function tail(s: string, lines = 30): string {
  return s.split(/\r?\n/).filter(Boolean).slice(-lines).join("\n");
}
