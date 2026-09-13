// app.js — NEXO.AI interface: streaming chat (Claude), THINK → DESIGN → BUILD
// status, the living hologram, live build preview, NEXO's voice and voice input.

import { Hologram, HoloState } from './hologram.js';

const $ = (s) => document.querySelector(s);

// ---------- config ----------
async function getJSON(url, opts) {
  const r = await fetch(url, opts);
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.statusText);
  return r.json();
}
const cfg = await getJSON('/api/config').catch(() => ({ persona: {}, aiReady: false }));
const persona = cfg.persona || {};

const livePill = $('#live');
if (!cfg.aiReady) {
  livePill.classList.add('demo');
  livePill.querySelector('b').textContent = 'DEMO';
  livePill.title = 'No ANTHROPIC_API_KEY set — add it to .env to go live';
} else {
  livePill.title = cfg.provider === 'qwen'
    ? `Live · ${cfg.model} (Qwen fallback — add ANTHROPIC_API_KEY to switch to Claude)`
    : `Live · ${cfg.model} · effort ${cfg.effort}`;
}

// ---------- markdown ----------
function md(text) {
  if (window.marked) {
    window.marked.setOptions({ breaks: true });
    return window.marked.parse(text || '');
  }
  return (text || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/\n/g, '<br>');
}
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// Pull the html build out of a reply. Returns { prose, html, complete }.
function extractBuild(text) {
  const open = text.match(/```html\s*\n?/i);
  if (!open) return { prose: text, html: null, complete: false, tail: '' };
  const start = open.index;
  const bodyStart = start + open[0].length;
  const closeIdx = text.indexOf('```', bodyStart);
  if (closeIdx === -1) {
    return { prose: text.slice(0, start), html: text.slice(bodyStart), complete: false, tail: '' };
  }
  return {
    prose: text.slice(0, start),
    html: text.slice(bodyStart, closeIdx),
    complete: true,
    tail: text.slice(closeIdx + 3),
  };
}
function titleOf(html) {
  const m = html.match(/<title[^>]*>([^<]*)<\/title>/i);
  return (m ? m[1].trim() : '') || 'index.html';
}

// ---------- toast ----------
const toastEl = $('#toast');
function toast(text, kind = '') {
  toastEl.className = `toast show ${kind}`;
  toastEl.textContent = text;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { toastEl.className = 'toast'; }, 3200);
}

// ---------- stage: the hologram, steps, callout ----------
const stage = $('#stage');
const holo = new Hologram($('#holo'));
window.nexo = { holo, HoloState }; // console access: nexo.holo.setState('speaking')
const stepEls = [...document.querySelectorAll('.steps li')];
const calloutText = $('#callout-text');
const thoughtEl = $('#thought');
const ORDER = ['thinking', 'designing', 'building', 'live'];
const steps = {
  set(name) {
    const idx = ORDER.indexOf(name);
    stepEls.forEach((li, i) => {
      li.classList.toggle('done', i < idx);
      li.classList.toggle('active', i === idx);
    });
  },
  reset() { stepEls.forEach((li) => li.classList.remove('done', 'active')); },
};
const HOLO = {
  idle: HoloState.IDLE, listening: HoloState.LISTENING, thinking: HoloState.THINKING,
  designing: HoloState.DESIGNING, building: HoloState.BUILDING, speaking: HoloState.SPEAKING,
};
function setState(s) { stage.dataset.state = s; holo.setState(HOLO[s] || HoloState.IDLE); }
function setLevel(v) { holo.setAudioLevel(v); }
function setCallout(t) { calloutText.textContent = t; }
// live thinking readout (Claude's summarized reasoning while THINKING is lit)
let thought = '';
function showThought(delta) {
  thought = (thought + delta).slice(-260);
  const tail = thought.split(/\n+/).filter(Boolean).pop() || '';
  thoughtEl.textContent = tail.slice(-150);
  thoughtEl.classList.add('show');
}
function clearThought() { thought = ''; thoughtEl.classList.remove('show'); }

// ---------- messages ----------
const messagesEl = $('#messages');
const cardDot = $('#card-dot');
function addMessage(who, label) {
  const el = document.createElement('div');
  el.className = `msg ${who}`;
  el.innerHTML = `<div class="who">${label}</div><div class="bubble"></div>`;
  messagesEl.appendChild(el);
  messagesEl.scrollTop = messagesEl.scrollHeight;
  return el.querySelector('.bubble');
}
function scrollDown() { messagesEl.scrollTop = messagesEl.scrollHeight; }

// greeting
addMessage('ai', 'NEXOVA AI').innerHTML = md(persona.greeting || 'NEXOVA AI online.');

// ---------- live build preview ----------
const preview = $('#preview');
const frame = $('#pv-frame');
const device = $('#device');
const previewName = $('#preview-name');
let currentHtml = null;
let previewMobile = false;

function showPreview(html, name) {
  currentHtml = html;
  frame.srcdoc = html;
  previewName.textContent = `LIVE BUILD · ${name}`.toUpperCase();
  preview.hidden = false;
  stage.classList.add("previewing");
  holo.paused = true;
  steps.set('live');
}
function hidePreview() {
  preview.hidden = true;
  stage.classList.remove("previewing");
  holo.paused = false;
  steps.reset();
}
function setDevice(mobile) {
  previewMobile = mobile;
  device.classList.toggle('mobile', mobile);
  $('#pv-mobile').classList.toggle('on', mobile);
  $('#pv-desktop').classList.toggle('on', !mobile);
}
$('#pv-desktop').addEventListener('click', () => setDevice(false));
$('#pv-mobile').addEventListener('click', () => setDevice(true));
$('#pv-close').addEventListener('click', hidePreview);
$('#pv-open').addEventListener('click', () => {
  if (!currentHtml) return;
  const url = URL.createObjectURL(new Blob([currentHtml], { type: 'text/html' }));
  window.open(url, '_blank');
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
});

// ---------- NEXO's voice OUTPUT (Qwen TTS) ----------
function stripForSpeech(text) {
  return (text || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/```[\s\S]*$/g, ' ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[#*_>`▸•]/g, ' ')
    .replace(/\|/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
function chunkForSpeech(text, maxLen = 220) {
  const clean = stripForSpeech(text);
  if (!clean) return [];
  const parts = clean.match(/[^.!?…]+[.!?…]+|\S[^.!?…]*$/g) || [clean];
  const chunks = [];
  let cur = '';
  for (const p of parts) {
    const s = p.trim();
    if (!s) continue;
    if ((cur + ' ' + s).trim().length > maxLen && cur) { chunks.push(cur.trim()); cur = s; }
    else cur = (cur + ' ' + s).trim();
  }
  if (cur) chunks.push(cur.trim());
  return chunks;
}

class Speaker {
  constructor() {
    this.audio = new Audio();
    this.audio.preload = 'auto';
    this.ctx = null; this.analyser = null; this._data = null;
    this.onLevel = null; this.playing = false; this._token = 0;
  }
  _ensureGraph() {
    if (this.ctx) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    this.ctx = new AC();
    const src = this.ctx.createMediaElementSource(this.audio);
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 256;
    this.analyser.smoothingTimeConstant = 0.75;
    src.connect(this.analyser);
    this.analyser.connect(this.ctx.destination);
    this._data = new Uint8Array(this.analyser.frequencyBinCount);
    const loop = () => {
      requestAnimationFrame(loop);
      if (!this.playing || !this.analyser) return;
      this.analyser.getByteFrequencyData(this._data);
      let sum = 0;
      for (const v of this._data) sum += v;
      this.onLevel?.(Math.min(1, (sum / this._data.length / 255) * 1.8));
    };
    loop();
  }
  async _fetchChunk(text, voice, token) {
    try {
      const r = await fetch('/api/tts', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, voice }),
      });
      if (!r.ok || token !== this._token) return null;
      const blob = await r.blob();
      if (token !== this._token) return null;
      return URL.createObjectURL(blob);
    } catch { return null; }
  }
  _playUrl(url) {
    return new Promise((resolve) => {
      this.audio.src = url;
      this.playing = true;
      const done = () => { this.audio.onended = null; this.audio.onerror = null; resolve(); };
      this.audio.onended = done; this.audio.onerror = done;
      this.audio.play().catch(done);
    });
  }
  async speak(text, { voice, onLevel, onStart, onEnd } = {}) {
    this.stop();
    const token = ++this._token;
    this.onLevel = onLevel || null;
    this._ensureGraph();
    if (this.ctx.state === 'suspended') { try { await this.ctx.resume(); } catch {} }
    const chunks = chunkForSpeech(text);
    if (!chunks.length) return;
    onStart?.();
    let nextUrl = this._fetchChunk(chunks[0], voice, token);
    for (let i = 0; i < chunks.length; i++) {
      if (token !== this._token) break;
      const url = await nextUrl;
      if (i + 1 < chunks.length) nextUrl = this._fetchChunk(chunks[i + 1], voice, token);
      if (!url || token !== this._token) continue;
      await this._playUrl(url);
      URL.revokeObjectURL(url);
    }
    if (token === this._token) { this.playing = false; this.onLevel?.(0); onEnd?.(); }
  }
  stop() {
    this._token++; this.playing = false;
    try { this.audio.pause(); } catch {}
    this.onLevel?.(0);
  }
}

// Browser fallback voice (Web Speech API) with a synthetic amplitude so the
// hologram still moves its visor line while it talks.
class BrowserSpeaker {
  constructor() { this.playing = false; this._u = null; this._raf = null; }
  speak(text, { onLevel, onStart, onEnd } = {}) {
    this.stop();
    const clean = stripForSpeech(text);
    if (!clean || !('speechSynthesis' in window)) return;
    const u = new SpeechSynthesisUtterance(clean);
    u.rate = 1.0; u.pitch = 0.95;
    const voices = speechSynthesis.getVoices();
    u.voice = voices.find((v) => /en-GB|en-US/.test(v.lang) && /Google|Natural|Online|Ryan|Guy|Mark/i.test(v.name))
      || voices.find((v) => /^en/.test(v.lang)) || null;
    this._u = u;
    let t0 = 0;
    const tick = (now) => {
      if (!this.playing) return;
      if (!t0) t0 = now;
      const s = (now - t0) / 1000;
      onLevel?.(0.35 + 0.25 * Math.abs(Math.sin(s * 9.3)) + 0.2 * Math.abs(Math.sin(s * 23.7)));
      this._raf = requestAnimationFrame(tick);
    };
    u.onstart = () => { this.playing = true; onStart?.(); this._raf = requestAnimationFrame(tick); };
    u.onend = u.onerror = () => { if (this._u !== u) return; this.playing = false; cancelAnimationFrame(this._raf); onLevel?.(0); onEnd?.(); };
    speechSynthesis.speak(u);
  }
  stop() { this.playing = false; cancelAnimationFrame(this._raf); this._u = null; try { speechSynthesis.cancel(); } catch {} }
}

const speaker = cfg.voiceEngine === 'qwen' ? new Speaker() : new BrowserSpeaker();
const voiceReady = !!cfg.voiceReady;
const voice = cfg.voice || 'Ethan';
let speakOn = false;
const voiceBtn = $('#voice');
if (cfg.voiceEngine !== 'qwen') voiceBtn.title = 'Speak replies aloud (browser voice — add QWEN_API_KEY for the Qwen voice)';

function speakNow(text) {
  if (!voiceReady) return;
  speaker.speak(text, {
    voice,
    onLevel: (l) => { setLevel(l); if (l > 0.02 && stage.dataset.state !== 'listening') setState('speaking'); },
    onStart: () => { setState('speaking'); setCallout('SPEAKING'); },
    onEnd: () => { setLevel(0); setState('idle'); setCallout('ONLINE'); },
  });
}
function stopSpeaking() { speaker.stop(); setLevel(0); if (stage.dataset.state === 'speaking') { setState('idle'); setCallout('ONLINE'); } }

if (!voiceReady) { voiceBtn.disabled = true; voiceBtn.title = 'Voice offline (no API key)'; }
voiceBtn.addEventListener('click', () => {
  speakOn = !speakOn;
  voiceBtn.classList.toggle('on', speakOn);
  voiceBtn.textContent = speakOn ? 'VOICE ON' : 'VOICE OFF';
  if (speakOn) { toast('🔊 NEXO will speak its replies', 'ok'); speakNow(persona.greeting || 'NEXOVA AI online.'); }
  else stopSpeaking();
});

// ---------- chat streaming ----------
async function streamChat(messages, { onDelta, onThinking, onDone, onError, signal } = {}) {
  let finished = false;   // a 'done' or 'error' event arrived
  try {
    const res = await fetch('/api/chat', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages }), signal,
    });
    if (!res.ok || !res.body) { onError?.(new Error('chat request failed')); return ''; }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '', full = '';
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const events = buf.split('\n\n');
      buf = events.pop();
      for (const ev of events) {
        const line = ev.split('\n').find((l) => l.startsWith('data: '));
        if (!line) continue;
        let obj; try { obj = JSON.parse(line.slice(6)); } catch { continue; }
        if (obj.type === 'delta') { full += obj.text; onDelta?.(obj.text, full); }
        else if (obj.type === 'thinking') onThinking?.(obj.text);
        else if (obj.type === 'done') { finished = true; onDone?.(obj); }
        else if (obj.type === 'error') { finished = true; onError?.(new Error(obj.error)); }
      }
    }
    // the connection closed without a terminal event (dropped mid-stream)
    if (!finished) onError?.(new Error('The connection dropped mid-reply — please send that again.'));
    return full;
  } catch (err) {
    // network failure, aborted stream, or a rendering exception — never leave the UI stuck
    if (!finished) onError?.(err instanceof Error ? err : new Error(String(err)));
    return '';
  }
}

// Conversation history. Older page builds are trimmed before sending so only
// the latest full page rides along as context (keeps tokens sane).
const history = [];
function historyForApi() {
  let lastBuild = -1;
  history.forEach((m, i) => { if (m.role === 'assistant' && /```html/i.test(m.content)) lastBuild = i; });
  return history.map((m, i) => {
    if (m.role !== 'assistant' || i === lastBuild) return m;
    return { ...m, content: m.content.replace(/```html[\s\S]*?```/gi, '```html\n<!-- earlier version of the page, superseded -->\n```') };
  });
}

// Render a reply bubble: prose + (if present) a build card instead of raw code.
function renderReply(bubble, text, { streaming }) {
  const b = extractBuild(text);
  if (b.html === null) { bubble.innerHTML = md(text); return b; }
  const lines = b.html.split('\n').length;
  const name = titleOf(b.html);
  const status = b.complete ? 'BUILT' : 'BUILDING…';
  bubble.innerHTML = `${md(b.prose)}
    <div class="build ${b.complete ? '' : 'working'}">
      <i></i><span class="name" title="${esc(name)}">${esc(name)}</span>
      <span class="meta">${lines} lines · ${status}</span>
      ${b.complete ? '<button type="button" data-preview>PREVIEW</button>' : ''}
    </div>${b.complete && b.tail.trim() ? md(b.tail) : ''}`;
  if (b.complete) {
    bubble.querySelector('[data-preview]')?.addEventListener('click', () => showPreview(b.html, name));
  }
  return b;
}

// ---------- composer ----------
const input = $('#input');
const sendBtn = $('#send');
const composer = $('#composer');
const chipsEl = $('#chips');
let busy = false;

input.addEventListener('input', () => composer.classList.toggle('has-text', !!input.value));

async function send(textOverride) {
  const text = (textOverride ?? input.value).trim();
  if (!text || busy) return;
  stopSpeaking();
  busy = true; sendBtn.disabled = true; cardDot.classList.add('busy');
  chipsEl.querySelectorAll('button').forEach((b) => (b.disabled = true));
  input.value = ''; composer.classList.remove('has-text');

  addMessage('user', 'FOUNDER').textContent = text;
  history.push({ role: 'user', content: text });

  // a "mobile version" ask flips the preview into the phone frame
  if (/mobile (version|view)|on (my )?phone/i.test(text)) setDevice(true);

  const bubble = addMessage('ai', 'NEXOVA AI');
  bubble.classList.add('cursor');
  setState('thinking'); steps.set('thinking'); setCallout('THINKING');

  let acc = '';
  let phase = 'thinking';
  let lastRender = 0;
  const finish = () => {
    clearThought();
    busy = false; sendBtn.disabled = false; cardDot.classList.remove('busy');
    chipsEl.querySelectorAll('button').forEach((el) => (el.disabled = false));
  };
  await streamChat(historyForApi(), {
    onThinking: (delta) => { if (phase === 'thinking') { showThought(delta); holo.pulse(0.08); } },
    onDelta: (chunk, full) => {
      acc = full;
      if (phase === 'thinking') { phase = 'designing'; steps.set('designing'); setCallout('DESIGNING'); setState('designing'); clearThought(); }
      if (phase === 'designing' && /```html/i.test(full)) { phase = 'building'; steps.set('building'); setCallout('BUILDING'); setState('building'); }
      holo.pulse(0.02);
      // throttle DOM work while a long page streams in
      const now = performance.now();
      if (now - lastRender > 80) { lastRender = now; renderReply(bubble, full, { streaming: true }); scrollDown(); }
    },
    onDone: (info) => {
      bubble.classList.remove('cursor');
      const b = renderReply(bubble, acc, { streaming: false });
      history.push({ role: 'assistant', content: acc });
      scrollDown();
      if (b.html && b.complete) {
        const name = titleOf(b.html);
        showPreview(b.html, name);
        setCallout('LIVE');
        fetch('/api/log', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ title: name, brief: text }),
        }).catch(() => {});
      } else {
        steps.reset();
        setCallout('ONLINE');
      }
      if (info?.stop_reason === 'max_tokens') toast('The reply hit the token limit — raise MAX_TOKENS in .env for bigger pages.', 'warn');
      if (info?.stop_reason === 'refusal') toast('NEXO declined that request.', 'warn');
      if (info?.fallback) toast(`Served by a fallback model: ${info.fallback}`, '');
      setState('idle');
      finish();
      if (speakOn) speakNow(b.html ? `${b.prose} ${b.tail || ''}` : acc);
      input.focus();
    },
    onError: (err) => {
      bubble.classList.remove('cursor');
      bubble.classList.add('error');
      bubble.innerHTML = md(`⚠ ${err.message}`);
      steps.reset(); setState('idle'); setCallout('ONLINE');
      finish();
    },
  });
}

composer.addEventListener('submit', (e) => { e.preventDefault(); send(); });
input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); send(); } });

// suggestion chips (exactly the three from the design)
for (const s of persona.suggestions || []) {
  const b = document.createElement('button');
  b.type = 'button';
  b.textContent = s;
  b.addEventListener('click', () => send(s));
  chipsEl.appendChild(b);
}

// ---------- voice INPUT (speech recognition) ----------
const micBtn = $('#mic');
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
let rec = null;
let listening = false;

function setListening(on) {
  listening = on;
  micBtn.classList.toggle('on', on);
  if (on) { setState('listening'); setCallout('LISTENING'); }
  else if (stage.dataset.state === 'listening') { setState('idle'); setCallout('ONLINE'); }
}
function startListening() {
  stopSpeaking(); // barge-in
  let finalText = '';
  try {
    rec = new SR(); // fresh instance each time — a reused one gets stuck after the first run
    rec.lang = 'en-US';
    rec.interimResults = true;
    rec.continuous = false;
    rec.maxAlternatives = 1;
    rec.onstart = () => setListening(true);
    rec.onresult = (e) => {
      let interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const tr = e.results[i][0].transcript;
        if (e.results[i].isFinal) finalText += tr; else interim += tr;
      }
      input.value = (finalText + interim).trim();
      composer.classList.toggle('has-text', !!input.value);
    };
    rec.onerror = (e) => {
      setListening(false); rec = null;
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed')
        toast('Microphone blocked — allow it via the icon in your browser address bar.', 'warn');
      else if (e.error === 'no-speech') toast('Didn’t catch that — tap the mic and speak.', 'warn');
      else if (e.error !== 'aborted') toast(`Voice input error: ${e.error}`, 'warn');
    };
    rec.onend = () => { setListening(false); rec = null; if (input.value.trim()) send(); };
    rec.start();
  } catch (err) {
    setListening(false); rec = null;
    toast(`Could not start mic: ${err.message}`, 'warn');
  }
}
function stopListening() { try { rec?.stop(); } catch {} setListening(false); }

if (SR) micBtn.addEventListener('click', () => (listening ? stopListening() : startListening()));
else { micBtn.disabled = true; micBtn.title = 'Voice input not supported in this browser (try Chrome or Edge)'; }

// keyboard: Esc closes the preview
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !preview.hidden) hidePreview(); });
