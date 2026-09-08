/**
 * Tiny structured logger. Every log line can be mirrored into a job log via a sink so the
 * UI can stream what the engine is doing.
 */
export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogRecord {
  ts: string;
  level: LogLevel;
  ns: string;
  msg: string;
  data?: Record<string, unknown>;
}

export type LogSink = (rec: LogRecord) => void;

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

let globalLevel: LogLevel = (process.env.NEXOVA_LOG_LEVEL as LogLevel) || "info";
const sinks = new Set<LogSink>();

export function setLogLevel(level: LogLevel) {
  globalLevel = level;
}

export function addLogSink(sink: LogSink): () => void {
  sinks.add(sink);
  return () => sinks.delete(sink);
}

function emit(rec: LogRecord) {
  if (LEVELS[rec.level] >= LEVELS[globalLevel]) {
    const extra = rec.data && Object.keys(rec.data).length ? " " + safeJson(rec.data) : "";
    const line = `${rec.ts} ${rec.level.toUpperCase().padEnd(5)} [${rec.ns}] ${rec.msg}${extra}`;
    if (rec.level === "error") console.error(line);
    else if (rec.level === "warn") console.warn(line);
    else console.log(line);
  }
  for (const sink of sinks) {
    try {
      sink(rec);
    } catch {
      /* never let a sink break the engine */
    }
  }
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

export interface Logger {
  ns: string;
  debug(msg: string, data?: Record<string, unknown>): void;
  info(msg: string, data?: Record<string, unknown>): void;
  warn(msg: string, data?: Record<string, unknown>): void;
  error(msg: string, data?: Record<string, unknown>): void;
  child(ns: string): Logger;
}

export function createLogger(ns: string): Logger {
  const make =
    (level: LogLevel) =>
    (msg: string, data?: Record<string, unknown>) =>
      emit({ ts: new Date().toISOString(), level, ns, msg, data });
  return {
    ns,
    debug: make("debug"),
    info: make("info"),
    warn: make("warn"),
    error: make("error"),
    child: (sub: string) => createLogger(`${ns}:${sub}`),
  };
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  return safeJson(err);
}
