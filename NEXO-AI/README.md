# NEXO.AI — NEXOVA AI, your website partner

*Idea to website. In real time.*

A living hologram AI for **Nexova Solutions** (THE X GROUP): a Claude-powered
creative OS that turns an idea into a working website while you watch. The
helmet is rendered live in Three.js — no image assets — and reacts to what NEXO
is doing: thinking, designing, building, speaking, listening.

Sister project of TRI-BRAIN (same JARVIS-style procedural approach).

## Run

```bash
npm install
npm start
```

→ http://localhost:3200

Open `.env` and paste your Anthropic key into `ANTHROPIC_API_KEY`. Until then, if a
`QWEN_API_KEY` is present, NEXO runs live on Qwen as a fallback (the pill tooltip
says so); with neither key
the app runs in DEMO mode (the interface works, NEXO can't think).

## How it works

- **Brain** — `brain/NEXO-Brain.md` is NEXO's entire system prompt (identity,
  Nexova context, design system, page playbooks, copy + build rules). Edit it to
  re-train NEXO; the server re-reads it on the next message, no restart.
- **Model** — Claude via the Anthropic SDK (`CLAUDE_MODEL`, default
  `claude-opus-5`) with adaptive thinking, `CLAUDE_EFFORT` (default `high`),
  prompt caching on the brain, and server-side refusal fallbacks. Claude's
  summarized reasoning streams onto the stage while THINKING is lit.
- **Build** — ask for a page ("Create a modern homepage for Nexova…") and NEXO
  replies with a complete single-file site. The hologram steps aside and the
  page renders live in a device frame (DESKTOP / MOBILE / OPEN ↗). Follow-ups
  ("Make it more minimal") return the whole updated page.
- **Hologram** — `public/js/hologram.js`: GLSL holographic shell with a visor
  cut-out, dark glass, a visor line that becomes the voice waveform, ear pods,
  glowing platform with data ticks, rising light beam, particles, bloom,
  glitches, and a gaze that follows the cursor. States drive scan sweeps, grid
  pulses and particle speed.
- **Voice** — `VOICE ON/OFF` in the card header. Qwen TTS when `QWEN_API_KEY`
  is set (voice `NEXO_VOICE`), otherwise the browser's own speech engine. The
  waveform icon in the composer is tap-to-talk (Chrome / Edge).
- **Memory** — every build is logged to Part 10 of the brain (`/api/log`).

## Files

```
brain/NEXO-Brain.md      the brain (edit me)
server/server.js         Express: /api/config, /api/chat (SSE), /api/tts, /api/log
public/index.html        the interface
public/css/styles.css    the look (proportions from design/mockup.png)
public/js/hologram.js    the Three.js hologram (modelled on design/helmet-reference.png)
public/holo.html         dev view: the hologram alone, full size (?state=speaking)
public/js/app.js         streaming, state machine, preview, voice
design/mockup.png        the reference design
design/helmet-reference.png   the helmet the hologram was modelled on
```
