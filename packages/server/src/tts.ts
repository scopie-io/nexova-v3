/**
 * NEXOVA AI's voice: Qwen3-TTS through DashScope, so the head sounds the same in every browser.
 *
 * Configured from the environment (see .env.example): QWEN_API_KEY turns it on; QWEN_TTS_MODEL,
 * QWEN_TTS_URL and NEXO_VOICE tune it. The head says the same short lines over and over
 * ("Welcome to Nexova…", "Publishing."), so every synthesis is kept on disk under data/tts and
 * served from there the next time.
 */
import path from "node:path";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";

export const TTS_VOICES = ["Ethan", "Cherry", "Serena", "Chelsie", "Neil", "Dylan", "Marcus", "Ryan", "Jennifer", "Elias"] as const;

export interface TtsConfig {
  apiKey: string;
  model: string;
  url: string;
  voice: string;
  cacheDir: string;
}

export function ttsConfigFromEnv(env: NodeJS.ProcessEnv, dataDir: string): TtsConfig | null {
  const apiKey = env.QWEN_API_KEY?.trim();
  if (!apiKey) return null;
  const voice = env.NEXO_VOICE?.trim();
  return {
    apiKey,
    model: env.QWEN_TTS_MODEL?.trim() || "qwen3-tts-flash",
    url: env.QWEN_TTS_URL?.trim() || "https://dashscope-intl.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation",
    voice: voice && (TTS_VOICES as readonly string[]).includes(voice) ? voice : "Ethan",
    cacheDir: path.join(dataDir, "tts"),
  };
}

export class TtsError extends Error {
  constructor(message: string, readonly status = 502) {
    super(message);
  }
}

/** WAV bytes for `text`, from the cache when the same line was said before. */
export async function synthesize(cfg: TtsConfig, text: string): Promise<Buffer> {
  const line = text.replace(/\s+/g, " ").trim().slice(0, 600);
  if (!line) throw new TtsError("text required", 400);
  const key = createHash("sha1").update(`${cfg.model}|${cfg.voice}|${line}`).digest("hex");
  const file = path.join(cfg.cacheDir, `${key}.wav`);
  try {
    return await fs.readFile(file);
  } catch {
    /* not cached yet */
  }

  const res = await fetch(cfg.url, {
    method: "POST",
    headers: { Authorization: `Bearer ${cfg.apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: cfg.model, input: { text: line, voice: cfg.voice, language_type: "English" } }),
  });
  const data = (await res.json().catch(() => ({}))) as { output?: { audio?: { url?: string } }; message?: string; code?: string };
  const url = data.output?.audio?.url;
  if (!res.ok || !url) throw new TtsError(data.message || data.code || `TTS synthesis failed (${res.status})`);
  const audio = await fetch(url);
  if (!audio.ok) throw new TtsError("Could not fetch the synthesized audio");
  const buf = Buffer.from(await audio.arrayBuffer());

  // best effort: the cache is a convenience, a read-only disk must not break the voice
  try {
    await fs.mkdir(cfg.cacheDir, { recursive: true });
    await fs.writeFile(file, buf);
  } catch {
    /* ignore */
  }
  return buf;
}
