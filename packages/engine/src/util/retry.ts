import { errorMessage } from "./log.js";

export interface RetryOptions {
  retries?: number;
  baseMs?: number;
  maxMs?: number;
  factor?: number;
  shouldRetry?: (err: unknown, attempt: number) => boolean;
  onRetry?: (err: unknown, attempt: number, delayMs: number) => void;
  signal?: AbortSignal;
}

export class TimeoutError extends Error {
  constructor(label: string, ms: number) {
    super(`${label} timed out after ${ms}ms`);
    this.name = "TimeoutError";
  }
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? new Error("aborted"));
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(signal?.reason ?? new Error("aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export async function withRetry<T>(fn: (attempt: number) => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const retries = opts.retries ?? 2;
  const baseMs = opts.baseMs ?? 800;
  const maxMs = opts.maxMs ?? 15_000;
  const factor = opts.factor ?? 2;
  let attempt = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      return await fn(attempt);
    } catch (err) {
      const retryable = opts.shouldRetry ? opts.shouldRetry(err, attempt) : true;
      if (attempt >= retries || !retryable || opts.signal?.aborted) throw err;
      const delay = Math.min(maxMs, baseMs * Math.pow(factor, attempt)) * (0.75 + Math.random() * 0.5);
      opts.onRetry?.(err, attempt + 1, Math.round(delay));
      await sleep(delay, opts.signal);
      attempt++;
    }
  }
}

export async function withTimeout<T>(promise: Promise<T>, ms: number, label = "operation"): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new TimeoutError(label, ms)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Run tasks with bounded concurrency; never rejects, returns settled results in order. */
export async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<Array<{ ok: true; value: R } | { ok: false; error: string }>> {
  const results: Array<{ ok: true; value: R } | { ok: false; error: string }> = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const i = next++;
      try {
        results[i] = { ok: true, value: await fn(items[i], i) };
      } catch (err) {
        results[i] = { ok: false, error: errorMessage(err) };
      }
    }
  });
  await Promise.all(workers);
  return results;
}
