import { EventEmitter } from "node:events";
import type { JobEvent } from "../schema/job.js";

/** Process-wide job event bus; the server bridges it to SSE. */
export class JobBus {
  private readonly emitter = new EventEmitter();
  private readonly history = new Map<string, JobEvent[]>();

  constructor(private readonly maxHistory = 400) {
    this.emitter.setMaxListeners(500);
  }

  publish(event: JobEvent): void {
    const list = this.history.get(event.jobId) ?? [];
    list.push(event);
    if (list.length > this.maxHistory) list.splice(0, list.length - this.maxHistory);
    this.history.set(event.jobId, list);
    this.emitter.emit(event.jobId, event);
    this.emitter.emit("*", event);
  }

  subscribe(jobId: string | "*", fn: (event: JobEvent) => void): () => void {
    this.emitter.on(jobId, fn);
    return () => this.emitter.off(jobId, fn);
  }

  replay(jobId: string): JobEvent[] {
    return [...(this.history.get(jobId) ?? [])];
  }

  forget(jobId: string): void {
    this.history.delete(jobId);
  }
}
