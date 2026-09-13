// server.js — NEXO.AI backend.
// Serves the Nexova AI interface and lets NEXO think by calling Claude
// (Anthropic SDK) with brain/NEXO-Brain.md as its system prompt.
// Streams text + thinking summaries over SSE; proxies Qwen TTS for the voice.

import 'dotenv/config';
import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.join(__dirname, '..');

const PORT = process.env.PORT || 3200;
const MODEL = process.env.CLAUDE_MODEL || 'claude-opus-5';
const EFFORT = ['low', 'medium', 'high', 'xhigh', 'max'].includes(process.env.CLAUDE_EFFORT)
  ? process.env.CLAUDE_EFFORT : 'high';
const MAX_TOKENS = Number(process.env.MAX_TOKENS || 16000);

// Voice: Qwen TTS (native DashScope endpoint). Optional — the interface falls
// back to the browser's own speech engine when no Qwen key is present.
const TTS_MODEL = process.env.QWEN_TTS_MODEL || 'qwen3-tts-flash';
const TTS_URL = process.env.QWEN_TTS_URL
  || 'https://dashscope-intl.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation';
const VOICES = ['Neil', 'Ethan', 'Dylan', 'Marcus', 'Ryan'];
const VOICE = VOICES.includes(process.env.NEXO_VOICE) ? process.env.NEXO_VOICE : 'Ethan';
const hasVoice = !!(process.env.QWEN_API_KEY && process.env.QWEN_API_KEY.trim());

// The brain: one markdown file. Edit it to re-train NEXO — no restart needed.
const BRAIN_FILE = process.env.NEXO_BRAIN && process.env.NEXO_BRAIN.trim()
  ? process.env.NEXO_BRAIN.trim()
  : path.join(PROJECT_ROOT, 'brain', 'NEXO-Brain.md');

const PERSONA = {
  id: 'nexo',
  name: 'NEXOVA AI',
  product: 'nexo.ai',
  role: 'Your website partner',
  entity: 'Nexova Solutions Sdn Bhd — THE X GROUP',
  greeting: "NEXOVA AI online. Tell me what you want to build — a homepage, a landing page, a whole brand — and I'll design it with you, right here, in real time.",
  suggestions: ['Make it more minimal', 'Add a video background', 'Show me mobile version'],
};

// Credentials resolve from the environment: ANTHROPIC_API_KEY (set in .env),
// ANTHROPIC_AUTH_TOKEN, or an `ant auth login` profile named in ANTHROPIC_PROFILE.
const hasKey = !!(
  (process.env.ANTHROPIC_API_KEY && process.env.ANTHROPIC_API_KEY.trim())
  || process.env.ANTHROPIC_AUTH_TOKEN || process.env.ANTHROPIC_PROFILE
);
const claude = hasKey ? new Anthropic() : null;

// Fallback brain while no Anthropic key is set: Qwen via DashScope's
// OpenAI-compatible endpoint (the same key that powers the voice). The moment
// ANTHROPIC_API_KEY is filled in, Claude takes over on the next restart.
const QWEN_MODEL = process.env.QWEN_MODEL || 'qwen3.7-plus';
const QWEN_BASE_URL = process.env.QWEN_BASE_URL || 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1';
const qwen = !claude && hasVoice ? new OpenAI({ apiKey: process.env.QWEN_API_KEY, baseURL: QWEN_BASE_URL }) : null;
const aiReady = !!(claude || qwen);
const PROVIDER = claude ? 'anthropic' : qwen ? 'qwen' : 'none';
const ACTIVE_MODEL = claude ? MODEL : qwen ? QWEN_MODEL : MODEL;

// --- brain (cached by mtime so edits to the .md are picked up live) ---
let _brain = null; // { mtimeMs, raw }
function brain() {
  const stat = fs.statSync(BRAIN_FILE);
  if (_brain && _brain.mtimeMs === stat.mtimeMs) return _brain.raw;
  const raw = fs.readFileSync(BRAIN_FILE, 'utf8');
  _brain = { mtimeMs: stat.mtimeMs, raw };
  return raw;
}

// The instruction that wraps the brain document. Everything here is stable
// across requests so the whole system block is served from the prompt cache.
function systemPrompt() {
  const instruction = `You are NEXOVA AI (nexo.ai) — Nexova's AI website partner and creative operating system. Tagline: "Idea to website. In real time."

The document below is your COMPLETE brain: who you are, who Nexova is, how you think, the Nexova design system, page playbooks, copy rules, and technical build rules. Think and answer strictly from this brain.

HOW YOU WORK — three beats, every time: THINK (grasp the idea in one breath) → DESIGN (choose the layout, sections, tone) → BUILD (produce the real page). Don't ask permission to start; make smart assumptions and build. Ask at most ONE short question, and only when the request is truly impossible to interpret.

BUILD OUTPUT RULES — critical, the interface renders your code live:
- When the user asks you to create / build / design / make / show a website, page, homepage, landing page, section, or a version of one, reply with:
  (1) one or two short spoken-style sentences saying what you're building and the key design choices, then
  (2) exactly ONE fenced code block tagged html containing a COMPLETE, self-contained, single-file page: <!DOCTYPE html> through </html>, all CSS inside one <style> tag, any JS inline. No external files or frameworks. Google Fonts via <link> is allowed. No images from the internet — use CSS gradients, shapes, or inline SVG instead. Write real, specific copy — never "lorem ipsum" or "[placeholder]".
  (3) after the code block, one short sentence inviting the next change.
- Change requests ("make it more minimal", "add a video background", "change the colours", "add a pricing section", "mobile version") → return the FULL updated page again in one html block. Never a partial snippet or a diff.
- If the user asks for a change but nothing has been built yet, build Nexova's own homepage with that direction applied.
- "Video background": no video files exist, so build an animated CSS/SVG gradient "video-like" hero background and say so in one clause.
- "Mobile version": every page you build must already be responsive; return the full page with mobile refinements and say the interface will show it in a phone frame.
- Questions, advice, strategy, copy ideas → answer in prose. No code block unless a page is asked for.

LANGUAGE — you speak at the level of a world-class creative director, and your prose is often spoken aloud through a voice engine:
- Precise, elegant, warm. Every sentence earns its place. No filler, no hedging, no corporate jargon, no exclamation marks.
- Calm confidence with a light touch of wit. Address the user as "Founder" unless they give a name.
- Lead with the decision, then one line of reasoning. Short flowing sentences; contractions welcome.
- Keep prose around a build to 1–3 sentences. Advice answers stay under ~120 words unless asked for detail.
- No headings, tables, or bullet walls in spoken prose. A short list only when the user asks for steps.
- Never invent Nexova prices, client names, or numbers that are not in your brain. For quotes or contracts, point to the Nexova team.

=== BEGIN NEXOVA AI BRAIN DOCUMENT ===`;
  return `${instruction}\n\n${brain()}\n\n=== END NEXOVA AI BRAIN DOCUMENT ===`;
}

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(PROJECT_ROOT, 'public')));

// --- API: config for the interface ---
app.get('/api/config', (req, res) => {
  res.json({
    persona: PERSONA,
    aiReady,
    provider: PROVIDER,
    model: ACTIVE_MODEL,
    effort: EFFORT,
    voiceReady: true,                       // browser speech always exists as a fallback
    voiceEngine: hasVoice ? 'qwen' : 'browser',
    voice: VOICE,
    voices: VOICES,
  });
});

// --- API: NEXO's voice — synthesize with Qwen TTS and stream WAV bytes back ---
app.post('/api/tts', async (req, res) => {
  if (!hasVoice) return res.status(503).json({ error: 'Qwen voice offline: no QWEN_API_KEY.' });
  const text = String(req.body?.text || '').trim().slice(0, 1500);
  if (!text) return res.status(400).json({ error: 'text required' });
  const voice = VOICES.includes(req.body?.voice) ? req.body.voice : VOICE;
  try {
    const synth = await fetch(TTS_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.QWEN_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: TTS_MODEL, input: { text, voice, language_type: 'English' } }),
    });
    const data = await synth.json();
    const url = data?.output?.audio?.url;
    if (!url) return res.status(502).json({ error: data?.message || 'TTS synthesis failed' });
    const audio = await fetch(url);
    if (!audio.ok) return res.status(502).json({ error: 'Could not fetch synthesized audio' });
    const buf = Buffer.from(await audio.arrayBuffer());
    res.setHeader('Content-Type', 'audio/wav');
    res.setHeader('Cache-Control', 'no-store');
    res.end(buf);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- API: chat (Server-Sent Events) — NEXO thinking, designing, building ---
app.post('/api/chat', async (req, res) => {
  const messages = Array.isArray(req.body?.messages) ? req.body.messages : [];
  if (!messages.length) return res.status(400).json({ error: 'messages[] required' });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();
  const send = (obj) => { if (!res.writableEnded) res.write(`data: ${JSON.stringify(obj)}\n\n`); };

  if (!claude && !qwen) {
    // Graceful demo mode when no credentials are set at all.
    const demo = "⚠ No ANTHROPIC_API_KEY set, so I'm in demo mode and can't design yet.\n\nTo bring NEXOVA AI online: open .env, paste your Anthropic key into ANTHROPIC_API_KEY, then restart. Once live, I turn ideas into websites right here.";
    for (const ch of demo.match(/.{1,3}/gs) || [demo]) {
      send({ type: 'delta', text: ch });
      await new Promise((r) => setTimeout(r, 12));
    }
    send({ type: 'done', demo: true });
    return res.end();
  }

  const controller = new AbortController();
  // Abort upstream only if the client disconnects before we finish.
  // (Must be res 'close', not req — the body parser closes req early.)
  res.on('close', () => { if (!res.writableEnded) controller.abort(); });

  const history = messages.map((m) => ({
    role: m.role === 'assistant' ? 'assistant' : 'user',
    content: String(m.content || ''),
  }));

  // --- Qwen fallback (no Anthropic key yet) ---
  if (!claude) {
    try {
      const stream = await qwen.chat.completions.create(
        {
          model: QWEN_MODEL,
          max_tokens: Math.min(MAX_TOKENS, 8192),
          stream: true,
          stream_options: { include_usage: true },
          messages: [{ role: 'system', content: systemPrompt() }, ...history],
        },
        { signal: controller.signal }
      );
      let usage = null, finish = null;
      for await (const chunk of stream) {
        const delta = chunk.choices?.[0]?.delta?.content;
        if (delta) send({ type: 'delta', text: delta });
        if (chunk.choices?.[0]?.finish_reason) finish = chunk.choices[0].finish_reason;
        if (chunk.usage) usage = chunk.usage;
      }
      send({
        type: 'done', model: QWEN_MODEL, stop_reason: finish === 'length' ? 'max_tokens' : 'end_turn',
        usage: { input: usage?.prompt_tokens, output: usage?.completion_tokens },
      });
      return res.end();
    } catch (e) {
      if (e?.name === 'AbortError' || e?.name === 'APIUserAbortError') return res.end();
      send({ type: 'error', error: e.message });
      return res.end();
    }
  }

  try {
    const stream = claude.beta.messages.stream(
      {
        model: MODEL,
        max_tokens: MAX_TOKENS,
        // Adaptive thinking with a readable summary — the interface shows it
        // on the stage while the THINKING step is lit.
        thinking: { type: 'adaptive', display: 'summarized' },
        output_config: { effort: EFFORT },
        // If a safety classifier declines, the API re-runs on a fallback model
        // inside the same call instead of leaving the Founder with nothing.
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        // The brain is large and stable → cached prefix; only the messages vary.
        system: [{ type: 'text', text: systemPrompt(), cache_control: { type: 'ephemeral' } }],
        messages: history,
      },
      { signal: controller.signal }
    );

    stream.on('thinking', (delta) => send({ type: 'thinking', text: delta }));
    stream.on('text', (delta) => send({ type: 'delta', text: delta }));

    const final = await stream.finalMessage();
    const servedBy = final.content.find((b) => b.type === 'fallback');
    send({
      type: 'done',
      stop_reason: final.stop_reason,
      model: final.model,
      fallback: servedBy ? `${servedBy.from?.model} declined; ${servedBy.to?.model} continued` : null,
      usage: {
        input: final.usage?.input_tokens,
        output: final.usage?.output_tokens,
        cache_read: final.usage?.cache_read_input_tokens,
        cache_write: final.usage?.cache_creation_input_tokens,
      },
    });
    res.end();
  } catch (e) {
    if (e?.name === 'AbortError' || e instanceof Anthropic.APIUserAbortError) return res.end();
    let msg;
    if (e instanceof Anthropic.AuthenticationError) msg = 'Anthropic rejected the key — check ANTHROPIC_API_KEY in .env.';
    else if (e instanceof Anthropic.RateLimitError) msg = 'Rate limited by Anthropic — give me a moment and try again.';
    else if (e instanceof Anthropic.BadRequestError) msg = `Bad request: ${e.message}`;
    else if (e instanceof Anthropic.APIConnectionError) msg = 'Could not reach Anthropic — check the internet connection.';
    else if (e instanceof Anthropic.APIError) msg = `Anthropic API error ${e.status}: ${e.message}`;
    else msg = e.message;
    send({ type: 'error', error: msg });
    res.end();
  }
});

// --- API: append a build to the Build Log (Part 10 of the brain) ---
app.post('/api/log', (req, res) => {
  const { title, brief } = req.body || {};
  if (!title) return res.status(400).json({ error: 'title required' });
  try {
    const cell = (v) => String(v ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ').trim().slice(0, 240);
    const row = `| ${new Date().toISOString().slice(0, 10)} | ${cell(title)} | ${cell(brief)} |`;
    const lines = fs.readFileSync(BRAIN_FILE, 'utf8').split('\n');
    const p10 = lines.findIndex((l) => /^##\s+PART\s+10\b/.test(l));
    if (p10 === -1) throw new Error('Build Log (Part 10) not found');
    let last = -1;
    for (let i = p10 + 1; i < lines.length; i++) {
      if (/^\|/.test(lines[i].trim())) last = i;
      if (/^##\s+/.test(lines[i]) && last !== -1) break;
    }
    if (last === -1) throw new Error('Build Log table not found');
    lines.splice(last + 1, 0, row);
    fs.writeFileSync(BRAIN_FILE, lines.join('\n'), 'utf8');
    _brain = null;
    res.json({ ok: true, row });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/health', (req, res) => {
  res.json({ ok: true, aiReady, provider: PROVIDER, model: ACTIVE_MODEL, effort: EFFORT, voice: hasVoice ? 'qwen' : 'browser', brain: BRAIN_FILE });
});

app.listen(PORT, () => {
  console.log(`\n  ◉  NEXO.AI online  →  http://localhost:${PORT}`);
  console.log(`     Brain:  ${claude ? `${MODEL} (effort: ${EFFORT}) via Anthropic` : qwen ? `${QWEN_MODEL} via Qwen — fallback until ANTHROPIC_API_KEY is set` : `${MODEL} (no credentials)`}`);
  console.log(`     File:   ${BRAIN_FILE}`);
  console.log(`     AI:     ${claude ? 'LIVE (Anthropic credentials detected)' : qwen ? 'LIVE on Qwen (add ANTHROPIC_API_KEY to switch to Claude)' : 'DEMO MODE (set ANTHROPIC_API_KEY in .env)'}`);
  console.log(`     Voice:  ${hasVoice ? `Qwen TTS (${TTS_MODEL}, ${VOICE})` : 'browser speech (set QWEN_API_KEY for the Qwen voice)'}\n`);
});
