/**
 * Job persistence: data/jobs/<id>/job.json plus step artifacts and attachments, so jobs survive
 * restarts and every intermediate (ingest, research, drafts, spec) can be inspected or replayed.
 */
import path from "node:path";
import { promises as fs } from "node:fs";
import type { EngineConfig } from "../config.js";
import { emptyUsage, initialSteps, type JobOptions, type JobRecord } from "../schema/job.js";
import { saveAttachments, type IncomingFile } from "../ingest/attachments.js";
import { appendLine, ensureDir, listDirs, readJsonOrNull, writeJson, writeText } from "../util/fsx.js";
import { newId } from "../util/ids.js";

export class JobStore {
  constructor(private readonly config: EngineConfig) {}

  dir(id: string): string {
    return path.join(this.config.dataDir, "jobs", id);
  }

  captureDir(id: string): string {
    return path.join(this.dir(id), "captures");
  }

  async create(raw: string, options: JobOptions = {}, files: IncomingFile[] = []): Promise<JobRecord> {
    const now = new Date().toISOString();
    const id = newId("job");
    const attachments = files.length ? await saveAttachments(files, path.join(this.dir(id), "attachments")) : [];
    const job: JobRecord = {
      id,
      status: "queued",
      input: { raw, options, attachments },
      steps: initialSteps(),
      slug: options.slug ?? null,
      templateId: options.templateId ?? null,
      siteUrl: null,
      usage: emptyUsage(),
      error: null,
      createdAt: now,
      updatedAt: now,
      artifacts: {},
    };
    await this.save(job);
    return job;
  }

  async save(job: JobRecord): Promise<void> {
    job.updatedAt = new Date().toISOString();
    await writeJson(path.join(this.dir(job.id), "job.json"), job);
  }

  async get(id: string): Promise<JobRecord | null> {
    if (!/^[a-z0-9_]+$/i.test(id)) return null;
    const job = await readJsonOrNull<JobRecord>(path.join(this.dir(id), "job.json"));
    if (job && !job.input.attachments) job.input.attachments = [];
    return job;
  }

  async list(limit = 50): Promise<JobRecord[]> {
    const ids = await listDirs(path.join(this.config.dataDir, "jobs"));
    const jobs: JobRecord[] = [];
    for (const id of ids) {
      const j = await this.get(id);
      if (j) jobs.push(j);
    }
    return jobs.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, limit);
  }

  async putArtifact(job: JobRecord, name: string, data: unknown): Promise<string> {
    const file = name.includes(".") ? name : `${name}.json`;
    const p = path.join(this.dir(job.id), file);
    if (typeof data === "string") await writeText(p, data);
    else await writeJson(p, data);
    job.artifacts[name] = file;
    return p;
  }

  async getArtifact<T = unknown>(job: JobRecord, name: string): Promise<T | null> {
    const file = job.artifacts[name];
    if (!file) return null;
    const p = path.join(this.dir(job.id), file);
    if (file.endsWith(".json")) return readJsonOrNull<T>(p);
    try {
      return (await fs.readFile(p, "utf8")) as unknown as T;
    } catch {
      return null;
    }
  }

  async appendLog(job: JobRecord, line: string): Promise<void> {
    await appendLine(path.join(this.dir(job.id), "log.txt"), line);
  }

  async init(): Promise<void> {
    await ensureDir(path.join(this.config.dataDir, "jobs"));
  }
}
