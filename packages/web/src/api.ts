export interface StepState {
  name: string;
  status: "pending" | "running" | "done" | "failed" | "skipped";
  message: string;
  error: string | null;
  startedAt: string | null;
  endedAt: string | null;
}
export interface Usage {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  webSearches: number;
  costUsd: number;
}
export interface Job {
  id: string;
  status: "queued" | "running" | "done" | "failed" | "cancelled";
  input: { raw: string; options: Record<string, unknown>; attachments?: Array<{ id: string; name: string; kind: string }> };
  steps: StepState[];
  slug: string | null;
  templateId: string | null;
  siteUrl: string | null;
  usage: Usage;
  error: string | null;
  createdAt: string;
}
export interface TemplateManifest {
  id: string;
  name: string;
  description: string;
  style: { tags: string[]; mode: string };
  industries: string[];
}
export interface StoreMeta {
  slug: string;
  name: string;
  templateId: string | null;
  siteUrl: string | null;
  products: number;
  updatedAt: string;
}
export interface Health {
  ok: boolean;
  model: string;
  offline: boolean;
  templates: string[];
  publicUrl: string;
}
export interface Coverage {
  sources: Array<{ url: string; platform: string; kind: string; status: string; discovered: boolean; strategies: string[]; attempted: string[]; products: number; images: number; profile: boolean; contacts: boolean; note: string }>;
  attachments: { total: number; extracted: number; products: number; images: number };
  totals: { products: number; withPrice: number; withImages: number; profiles: number; contacts: number; platforms: string[] };
  gaps: string[];
  recommendations: string[];
  score: number;
}
export type JobEvent =
  | { type: "status"; status: Job["status"] }
  | { type: "step"; step: StepState }
  | { type: "log"; record: { ts: string; level: string; ns: string; msg: string } }
  | { type: "usage"; usage: Usage }
  | { type: "progress"; step: string; message: string }
  | { type: "done"; job: Job }
  | { type: "error"; error: string };

export interface CreateOptions {
  templateId?: string | null;
  skipBuild?: boolean;
  skipResearch?: boolean;
  skipDiscovery?: boolean;
  instructions?: string | null;
  currency?: string | null;
}

async function j<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as { error?: string }).error || `HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

export const api = {
  health: () => fetch("/api/health").then((r) => j<Health>(r)),
  templates: () => fetch("/api/templates").then((r) => j<TemplateManifest[]>(r)),
  stores: () => fetch("/api/stores").then((r) => j<StoreMeta[]>(r)),
  job: (id: string) => fetch(`/api/jobs/${id}`).then((r) => j<Job>(r)),
  coverage: (id: string) => fetch(`/api/jobs/${id}/coverage`).then((r) => j<Coverage>(r)),
  createJob: (input: string, options: CreateOptions, files: File[] = []) => {
    if (files.length) {
      const fd = new FormData();
      fd.append("input", input);
      fd.append("options", JSON.stringify(options));
      for (const f of files) fd.append("files", f, f.name);
      return fetch("/api/jobs", { method: "POST", body: fd }).then((r) => j<Job>(r));
    }
    return fetch("/api/jobs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ input, options }) }).then((r) => j<Job>(r));
  },
  cancel: (id: string) => fetch(`/api/jobs/${id}/cancel`, { method: "POST" }).then((r) => j<{ cancelled: boolean }>(r)),
  rebuild: (slug: string, templateId?: string | null) => fetch(`/api/stores/${slug}/rebuild`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ templateId }) }).then((r) => j<Job>(r)),
  events(id: string, onEvent: (e: JobEvent) => void, onClose: () => void): () => void {
    const es = new EventSource(`/api/jobs/${id}/events`);
    const handler = (ev: MessageEvent) => {
      try {
        onEvent(JSON.parse(ev.data) as JobEvent);
      } catch {
        /* ignore */
      }
    };
    for (const t of ["status", "step", "log", "usage", "progress", "done", "error"]) es.addEventListener(t, handler as EventListener);
    es.onerror = () => {
      // Hosted functions cut long streams; the browser reconnects on its own with Last-Event-ID and the
      // server resumes from there. Only a permanent failure (readyState CLOSED) ends the subscription.
      if (es.readyState === EventSource.CLOSED) onClose();
    };
    return () => es.close();
  },
};

/** Client-side link classification for instant guidance (mirrors the engine's detect step loosely). */
export interface LinkHint {
  url: string;
  platform: string;
  label: string;
  tip: string | null;
  screenshotsHelp: boolean;
}

export function classifyForHint(line: string): LinkHint | null {
  const m = line.match(/https?:\/\/[^\s]+|(?:www\.)?[a-z0-9-]+\.[a-z.]{2,}\/[^\s]*/i);
  if (!m) return null;
  const url = m[0];
  const l = url.toLowerCase();
  if (/shop\.tiktok\.com|tiktok\.com\/(view|shop)\//.test(l)) return { url, platform: "tiktok_shop", label: "TikTok Shop", tip: "TikTok Shop blocks bots. 2–6 screenshots of your shop tab and product cards make this accurate.", screenshotsHelp: true };
  if (/tiktok\.com/.test(l)) return { url, platform: "tiktok", label: "TikTok profile", tip: "Profile bio and avatar are usually readable. Add a TikTok Shop screenshot for products.", screenshotsHelp: true };
  if (/instagram\.com/.test(l)) return { url, platform: "instagram", label: "Instagram", tip: "Works for public accounts. A screenshot of your grid or highlights adds products.", screenshotsHelp: false };
  if (/shopee\.|shp\.ee/.test(l)) return { url, platform: "shopee", label: "Shopee shop", tip: "Shopee often blocks automated reading. Screenshots of your shop page and product list fill the gap.", screenshotsHelp: true };
  if (/lazada\./.test(l)) return { url, platform: "lazada", label: "Lazada shop", tip: null, screenshotsHelp: true };
  if (/facebook\.com|fb\.com|fb\.me/.test(l)) return { url, platform: "facebook", label: "Facebook page", tip: "Public pages only. Screenshots of your Facebook Shop help.", screenshotsHelp: true };
  if (/myshopify\.com/.test(l)) return { url, platform: "shopify", label: "Shopify store", tip: "Full catalog with photos is read automatically.", screenshotsHelp: false };
  if (/linktr\.ee|beacons\.ai|bio\.site|lynk\.id|taplink|bento\.me/.test(l)) return { url, platform: "biolink", label: "Bio link page", tip: "We follow every shop link on it.", screenshotsHelp: false };
  return { url, platform: "website", label: "Website", tip: null, screenshotsHelp: false };
}
