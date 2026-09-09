/**
 * Job persistence: the job record, its step artifacts, attachments and log, through Storage so
 * jobs survive restarts and every intermediate (ingest, research, drafts, spec) can be inspected
 * or replayed. On disk this is data/jobs/<id>/; on Vercel it is Neon + Blob.
 */
import path from "node:path";
import type { EngineConfig } from "../config.js";
import { emptyUsage, initialSteps, type JobOptions, type JobRecord } from "../schema/job.js";
import { saveAttachments, type IncomingFile } from "../ingest/attachments.js";
import { artifactFile } from "../storage/fs.js";
import type { Storage } from "../storage/types.js";
import { newId } from "../util/ids.js";

export class JobStore {
  constructor(
    private readonly config: EngineConfig,
    private readonly storage: Storage,
  ) {}

  /** Scratch directory for a job (browser captures, composed sites). Always local disk (or /tmp on Vercel). */
  dir(id: string): string {
    return path.join(this.config.dataDir, "jobs", id);
  }

  captureDir(id: string): string {
    return path.join(this.dir(id), "captures");
  }

  async create(raw: string, options: JobOptions = {}, files: IncomingFile[] = []): Promise<JobRecord> {
    const now = new Date().toISOString();
    const id = newId("job");
    const attachments = files.length ? await saveAttachments(files, { storage: this.storage, keyPrefix: `attachments/${id}` }) : [];
    const job: JobRecord = {
      id,
      status: "queued",
      input: { raw, options, attachments },
      steps: initialSteps(),
      slug: options.slug ?? null,
      templateId: options.templateId ?? null,
      siteUrl: null,
      preview: false,
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
    await this.storage.put("jobs", job.id, job);
  }

  async get(id: string): Promise<JobRecord | null> {
    if (!/^[a-z0-9_]+$/i.test(id)) return null;
    const job = await this.storage.get<JobRecord>("jobs", id);
    if (job && !job.input.attachments) job.input.attachments = [];
    return job;
  }

  async list(limit = 50): Promise<JobRecord[]> {
    const entries = await this.storage.list<JobRecord>("jobs", { limit: Math.max(limit, 200) });
    return entries
      .map((e) => e.value)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit);
  }

  async putArtifact(job: JobRecord, name: string, data: unknown): Promise<string> {
    await this.storage.put(`artifacts/${job.id}`, name, data);
    job.artifacts[name] = artifactFile(name);
    return name;
  }

  async getArtifact<T = unknown>(job: JobRecord, name: string): Promise<T | null> {
    if (!job.artifacts[name]) return null;
    return this.storage.get<T>(`artifacts/${job.id}`, name);
  }

  async appendLog(job: JobRecord, line: string): Promise<void> {
    await this.storage.append(`joblog/${job.id}`, line);
  }

  async init(): Promise<void> {
    await this.storage.init();
  }
}
