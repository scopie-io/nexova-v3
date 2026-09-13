// app.js — the NEXOVA AI interface, wired to the Nexova engine.
//
// Paste a TikTok Shop / Shopee link (or product lines, or screenshots)  →  POST /api/jobs  →
// SSE progress drives the head, the THINK → DESIGN → BUILD → LIVE beats and the conversation
// →  the finished store renders live in the stage. Same API the classic builder at /classic/ uses.

import { Head, HeadState } from './head.js';
import { Voice } from './voice.js';

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

// ---------- Nexova API (mirrors packages/web/src/api.ts) ----------
async function j(res) {
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `HTTP ${res.status}`);
  }
  return res.json();
}
const api = {
  health: () => fetch('/api/health').then(j),
  templates: () => fetch('/api/templates').then(j),
  job: (id) => fetch(`/api/jobs/${encodeURIComponent(id)}`).then(j),
  coverage: (id) => fetch(`/api/jobs/${encodeURIComponent(id)}/coverage`).then(j),
  createJob(input, options, files = []) {
    if (files.length) {
      const fd = new FormData();
      fd.append('input', input);
      fd.append('options', JSON.stringify(options));
      for (const f of files) fd.append('files', f, f.name);
      return fetch('/api/jobs', { method: 'POST', body: fd }).then(j);
    }
    return fetch('/api/jobs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ input, options }) }).then(j);
  },
  cancel: (id) => fetch(`/api/jobs/${encodeURIComponent(id)}/cancel`, { method: 'POST' }).then(j),
  rebuild: (slug, templateId) => fetch(`/api/stores/${encodeURIComponent(slug)}/rebuild`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ templateId: templateId || null }) }).then(j),
  events(id, onEvent, onClose) {
    const es = new EventSource(`/api/jobs/${encodeURIComponent(id)}/events`);
    const handler = (ev) => { try { onEvent(JSON.parse(ev.data)); } catch { /* ignore */ } };
    for (const t of ['status', 'step', 'log', 'usage', 'progress', 'products', 'done', 'error']) es.addEventListener(t, handler);
    // The browser reconnects on its own with Last-Event-ID; only a permanent close ends the subscription.
    es.onerror = () => { if (es.readyState === EventSource.CLOSED) onClose(); };
    return () => es.close();
  },
};

// ---------- the engine's steps, in NEXOVA AI's words ----------
const STEP_LABELS = {
  detect: 'Reading your links',
  ingest: 'Collecting profile & products',
  discover: 'Finding your other channels',
  attachments: 'Reading screenshots & files',
  research: 'Researching your brand on the web',
  normalize: 'Building your catalog',
  assets: 'Saving your images',
  preview: 'Publishing a first preview',
  enrich: 'Designing copy, theme & layout',
  template: 'Choosing a template',
  compose: 'Assembling the website',
  build: 'Compiling the site',
  deploy: 'Publishing',
};
// 13 engine steps → the four beats on the stage
const BEAT_OF = {
  detect: 'thinking', ingest: 'thinking', discover: 'thinking', attachments: 'thinking', research: 'thinking',
  normalize: 'designing', assets: 'designing', preview: 'designing', enrich: 'designing', template: 'designing',
  compose: 'building', build: 'building', deploy: 'building',
};
// everything the head can say — fixed lines, so each one is a recorded clip (see js/voice.js)
const LINES = {
  greeting: "Welcome to Nexova. I'm your website partner. Paste your TikTok Shop or Shopee link, and I'll build your store while you watch.",
  canRead: 'I can read this.',
  canReadShots: 'I can read this. Screenshots will make it more accurate.',
  thinking: 'Reading your links.',
  found: 'Found your products.',
  designing: 'Building your catalog and designing your store.',
  firstVersion: 'A first version is up. Polishing it.',
  building: 'Publishing.',
  live: 'Your store is live.',
  dataReady: 'Your store data is ready.',
  cancelled: 'Cancelled.',
  stopped: 'The build stopped.',
  rebuilding: 'Rebuilding.',
};
// Wall-clock medians per step from a measured build (see packages/web/src/App.tsx) — for the ETA.
const STEP_MS = { detect: 600, ingest: 20_000, discover: 1_800, attachments: 2_000, research: 1_500, normalize: 28_300, assets: 9_400, preview: 7_800, enrich: 41_800, template: 1_500, compose: 3_000, build: 1_500, deploy: 1_800 };

function remainingMs(steps) {
  let left = 0;
  for (const s of steps) {
    if (s.status === 'done' || s.status === 'skipped' || s.status === 'failed') continue;
    const est = STEP_MS[s.name] ?? 0;
    if (s.status === 'running' && s.startedAt) left += Math.max(0, est - (Date.now() - new Date(s.startedAt).getTime()));
    else left += est;
  }
  return left;
}
function humanDuration(ms) {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return s % 60 >= 30 ? `${m}½ min` : `${m} min`;
}

// Client-side link classification for instant guidance (same rules as the classic home).
function classifyForHint(line) {
  const m = line.match(/https?:\/\/[^\s]+|(?:www\.)?[a-z0-9-]+\.[a-z.]{2,}\/[^\s]*/i);
  if (!m) return null;
  const url = m[0];
  const l = url.toLowerCase();
  if (/shop\.tiktok\.com|tiktok\.com\/(view|shop)\//.test(l)) return { url, label: 'TikTok Shop', screenshotsHelp: true };
  if (/tiktok\.com/.test(l)) return { url, label: 'TikTok profile', screenshotsHelp: true };
  if (/instagram\.com/.test(l)) return { url, label: 'Instagram', screenshotsHelp: false };
  if (/shopee\.|shp\.ee/.test(l)) return { url, label: 'Shopee', screenshotsHelp: true };
  if (/lazada\./.test(l)) return { url, label: 'Lazada', screenshotsHelp: true };
  if (/facebook\.com|fb\.com|fb\.me/.test(l)) return { url, label: 'Facebook', screenshotsHelp: true };
  if (/myshopify\.com/.test(l)) return { url, label: 'Shopify', screenshotsHelp: false };
  if (/linktr\.ee|beacons\.ai|bio\.site|lynk\.id|taplink|bento\.me/.test(l)) return { url, label: 'Bio link', screenshotsHelp: false };
  return { url, label: 'Website', screenshotsHelp: false };
}
function hintsFor(text) {
  const seen = new Set();
  return text.split(/\r?\n/).map((l) => classifyForHint(l.trim())).filter((h) => h && !seen.has(h.url) && seen.add(h.url));
}

// ---------- toast ----------
const toastEl = $('#toast');
function toast(text, kind = '') {
  toastEl.className = `toast show ${kind}`;
  toastEl.textContent = text;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { toastEl.className = 'toast'; }, 3200);
}

// ---------- stage: the head, the beats, the state pill ----------
const stage = $('#stage');
const head = new Head($('#head'));
const stepEls = [...document.querySelectorAll('.steps li')];
const livePill = $('#live');
const liveText = $('#live-text');
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
const HEAD = { idle: HeadState.IDLE, thinking: HeadState.THINKING, designing: HeadState.DESIGNING, building: HeadState.BUILDING };
function setState(s) {
  stage.dataset.state = s;
  if (head.state !== HeadState.SPEAKING) head.setState(HEAD[s] || HeadState.IDLE);
}
const voice = new Voice(head, $('#say'), () => HEAD[stage.dataset.state] || HeadState.IDLE);
const say = (text) => voice.say(text);

// sound: the head's lines are always shown; whether they are also spoken is remembered.
// The control names the action (MUTE / UNMUTE), and reads TAP FOR SOUND while a line waits for
// the first click or key, which browsers require before any page may play audio.
const soundBtn = $('#sound-toggle');
let waiting = false;
function soundLabel() { soundBtn.textContent = waiting ? 'TAP FOR SOUND' : voice.sound ? 'MUTE' : 'UNMUTE'; }
function applySound(on) {
  voice.sound = on;
  if (!on) voice.stop();
  try { localStorage.setItem('nexova.mute', on ? '' : '1'); } catch { /* ignore */ }
  soundLabel();
}
voice.onBlocked = (w) => { waiting = w; soundLabel(); };
let muted = false;
try { muted = localStorage.getItem('nexova.mute') === '1'; } catch { /* ignore */ }
applySound(!muted);
soundBtn.addEventListener('click', () => applySound(!voice.sound));

// the pill wears the state: ONLINE (or OFFLINE MODE / NO API) at rest, the beat while it builds, LIVE when the store is up
let health = null;
function setPill(t) {
  const rest = t === 'ONLINE';
  // phones get the short form of the one long state, so the row of controls never overflows
  const offline = matchMedia('(max-width: 480px)').matches ? 'OFFLINE' : 'OFFLINE MODE';
  liveText.textContent = rest ? (!health ? 'NO API' : health.offline ? offline : 'ONLINE') : t;
  livePill.classList.toggle('busy', /THINKING|DESIGNING|BUILDING/.test(t));
  livePill.classList.toggle('off', rest && (!health || health.offline));
}
function applyHealth(h) {
  health = h;
  if (!h) livePill.title = 'Cannot reach the Nexova API. Is the server running?';
  else if (h.offline) livePill.title = 'No ANTHROPIC_API_KEY: basic heuristics, screenshots cannot be read. Add the key to .env.';
  else livePill.title = `${h.model}${h.effort ? ` · effort ${h.effort}` : ''}`;
  setPill('ONLINE');
}
function idle() { setState('idle'); setPill('ONLINE'); }

// ---------- messages ----------
const messagesEl = $('#messages');
function addMessage(who) {
  const el = document.createElement('div');
  el.className = `msg ${who}`;
  el.innerHTML = '<div class="bubble"></div>';
  messagesEl.appendChild(el);
  scrollDown();
  return el.firstElementChild;
}
function scrollDown() { messagesEl.scrollTop = messagesEl.scrollHeight; }

// ---------- live store preview ----------
const preview = $('#preview');
const frame = $('#pv-frame');
const device = $('#device');
const previewName = $('#preview-name');
let currentUrl = null;

function showPreview(url, name, { polishing = false, reload = false } = {}) {
  const abs = new URL(url, location.href).toString();
  // a rebuilt store keeps its URL: bust the cache when we know it changed
  const src = reload ? `${abs}${abs.includes('?') ? '&' : '?'}_=${Date.now()}` : abs;
  if (currentUrl !== abs || reload) frame.src = src;
  currentUrl = abs;
  previewName.textContent = `${polishing ? 'FIRST PREVIEW' : 'LIVE'} · ${name}`.toUpperCase();
  preview.hidden = false;
  stage.classList.add('previewing');
}
function hidePreview() {
  preview.hidden = true;
  stage.classList.remove('previewing');
}
function setDevice(mobile) {
  device.classList.toggle('mobile', mobile);
  $('#pv-mobile').classList.toggle('on', mobile);
  $('#pv-desktop').classList.toggle('on', !mobile);
}
$('#pv-desktop').addEventListener('click', () => setDevice(false));
$('#pv-mobile').addEventListener('click', () => setDevice(true));
$('#pv-close').addEventListener('click', hidePreview);
$('#pv-open').addEventListener('click', () => { if (currentUrl) window.open(currentUrl, '_blank', 'noopener'); });

// ---------- options (template, currency, instructions, skips) ----------
const optionsEl = $('#options');
const optionsBtn = $('#options-toggle');
const optTemplate = $('#opt-template');
optionsBtn.addEventListener('click', () => {
  optionsEl.hidden = !optionsEl.hidden;
  optionsBtn.classList.toggle('on', !optionsEl.hidden);
});
function fillTemplates(list) {
  for (const t of list) {
    const o = document.createElement('option');
    o.value = t.id;
    o.textContent = t.name;
    optTemplate.appendChild(o);
  }
}
function buildOptions() {
  return {
    templateId: optTemplate.value || null,
    currency: $('#opt-currency').value.trim().toUpperCase() || null,
    instructions: $('#opt-instructions').value.trim() || null,
    skipDiscovery: $('#opt-skip-discovery').checked,
    skipResearch: $('#opt-skip-research').checked,
    skipBuild: $('#opt-skip-build').checked,
  };
}

// ---------- chips: what the pasted links are, and a way to add screenshots ----------
const chipsEl = $('#chips');
function renderChips() {
  const hints = hintsFor(input.value);
  if (!hints.length) { chipsEl.innerHTML = ''; return; }
  const wantsShots = hints.some((h) => h.screenshotsHelp);
  chipsEl.innerHTML = hints.map((h) => `<span class="hint">${esc(h.label)}</span>`).join('')
    + (wantsShots ? '<button type="button" data-add-files>ADD SCREENSHOTS</button>' : '');
}
chipsEl.addEventListener('click', (e) => {
  if (e.target.closest('button[data-add-files]')) fileInput.click();
});

// ---------- attachments: screenshots & CSV (the chip, drag & drop, paste) ----------
const composer = $('#composer');
const input = $('#input');
const sendBtn = $('#send');
const fileInput = $('#files');
const filesStrip = $('#files-strip');
let picked = []; // { file, url }

function addFiles(list) {
  for (const f of Array.from(list)) {
    const ok = /^image\/(png|jpe?g|webp|gif)$/.test(f.type) || /\.(csv|tsv|json|txt)$/i.test(f.name);
    if (!ok || f.size > 20 * 1024 * 1024) { toast(`Skipped ${f.name}: PNG, JPG, WEBP, GIF or CSV up to 20 MB.`, 'warn'); continue; }
    if (picked.length >= 30) { toast('Up to 30 files per build.', 'warn'); break; }
    picked.push({ file: f, url: f.type.startsWith('image/') ? URL.createObjectURL(f) : null });
  }
  renderFiles();
}
function clearFiles() {
  for (const p of picked) if (p.url) URL.revokeObjectURL(p.url);
  picked = [];
  renderFiles();
}
function renderFiles() {
  filesStrip.hidden = !picked.length;
  filesStrip.innerHTML = picked.map((p, i) => {
    const name = p.file.name.length > 22 ? `${p.file.name.slice(0, 19)}…` : p.file.name;
    const ext = (p.file.name.split('.').pop() || 'file').toUpperCase().slice(0, 4);
    return `<span class="file">${p.url ? `<img src="${p.url}" alt="">` : `<b>${esc(ext)}</b>`}<span title="${esc(p.file.name)}">${esc(name)}</span><button type="button" data-remove="${i}" aria-label="Remove ${esc(p.file.name)}">×</button></span>`;
  }).join('');
}
filesStrip.addEventListener('click', (e) => {
  const b = e.target.closest('[data-remove]');
  if (!b) return;
  const [gone] = picked.splice(Number(b.dataset.remove), 1);
  if (gone?.url) URL.revokeObjectURL(gone.url);
  renderFiles();
});
fileInput.addEventListener('change', () => { if (fileInput.files?.length) addFiles(fileInput.files); fileInput.value = ''; });
composer.addEventListener('dragover', (e) => { e.preventDefault(); composer.classList.add('dragging'); });
composer.addEventListener('dragleave', () => composer.classList.remove('dragging'));
composer.addEventListener('drop', (e) => {
  e.preventDefault();
  composer.classList.remove('dragging');
  if (e.dataTransfer?.files?.length) addFiles(e.dataTransfer.files);
});
window.addEventListener('paste', (e) => {
  const items = e.clipboardData?.items;
  if (!items) return;
  const files = [];
  for (const it of Array.from(items)) {
    if (it.kind !== 'file') continue;
    const f = it.getAsFile();
    if (f) files.push(new File([f], f.name && f.name !== 'image.png' ? f.name : `screenshot-${Date.now()}.png`, { type: f.type }));
  }
  if (files.length) { addFiles(files); e.preventDefault(); }
});

// ---------- composer ----------
let isBusy = false;
function setBusy(on) {
  isBusy = on;
  sendBtn.disabled = on;
}
function autosize() {
  input.style.height = 'auto';
  input.style.height = `${Math.min(input.scrollHeight, 168)}px`;
}
let hintTimer = 0;
let lastHintKey = '';
input.addEventListener('input', () => {
  autosize();
  renderChips();
  clearTimeout(hintTimer);
  hintTimer = setTimeout(() => {
    if (isBusy) return;
    const hints = hintsFor(input.value);
    const key = hints.map((h) => h.label).join('|');
    if (key === lastHintKey) return;
    lastHintKey = key;
    if (!hints.length) return;
    say(hints.some((h) => h.screenshotsHelp) ? LINES.canReadShots : LINES.canRead);
  }, 700);
});

// ---------- the build ----------
let run = null;      // the active (or last) build
let lastInput = null; // { text, files } for TRY AGAIN

function isTerminal(job) { return job.status === 'done' || job.status === 'failed' || job.status === 'cancelled'; }
function beatOf(job) {
  const active = job.steps.find((s) => s.status === 'running');
  const last = [...job.steps].reverse().find((s) => s.status === 'done' || s.status === 'skipped');
  return BEAT_OF[(active ?? last)?.name] ?? 'thinking';
}

function attach(job, bubble) {
  detach();
  const r = { job, bubble, progress: {}, found: null, coverage: null, beat: null, done: false, earlyPreview: false };
  run = r;
  history.replaceState(null, '', `${location.pathname}?job=${encodeURIComponent(job.id)}`);
  setBusy(true);
  applyBeat(r, beatOf(job));
  renderRun(r);
  r.stop = api.events(job.id, (e) => onEvent(r, e), () => reconcile(r));
  // Safety net: the record is the source of truth, so poll it while the job is active in case the
  // stream misses a beat.
  r.poll = setInterval(() => reconcile(r), 15_000);
  r.ticker = setInterval(() => updateMeta(r), 1000);
  // A build resumed from the URL that already finished is not closed here: the stream replays its
  // events (the products among them) and ends with the final record; reconcile() is the fallback.
}
function detach() {
  if (!run) return;
  run.stop?.(); clearInterval(run.poll); clearInterval(run.ticker);
  run.stop = null; run.poll = null; run.ticker = null;
}
async function reconcile(r) {
  if (r.done) return;
  const latest = await api.job(r.job.id).catch(() => null);
  if (!latest || r.done) return;
  if (latest.updatedAt >= r.job.updatedAt) r.job = latest;
  if (isTerminal(r.job)) finishRun(r);
  else onJobUpdate(r);
}
function onEvent(r, e) {
  if (e.type === 'products') {
    // arrives during the run, and again on a replay after a resumed build has already finished
    r.found = { products: e.products, total: e.total };
    renderRun(r);
    if (!r.done) say(LINES.found);
    return;
  }
  if (r.done) return;
  switch (e.type) {
    case 'step': {
      r.job.steps = r.job.steps.map((s) => (s.name === e.step.name ? { ...s, ...e.step } : s));
      if (e.step.name === 'preview' && e.step.status === 'done') earlyPreview(r);
      if (e.step.name === 'attachments' && e.step.status !== 'running') loadCoverage(r);
      onJobUpdate(r);
      break;
    }
    case 'status': r.job.status = e.status; updateMeta(r); break;
    case 'usage': r.job.usage = e.usage; break;
    case 'progress': r.progress[e.step] = e.message; head.pulse(0.35); updateMeta(r); break;
    // only a terminal event (or the record itself, via reconcile) ends the run: they carry the final job
    case 'done': r.job = e.job; finishRun(r); break;
    case 'error': { if (r.job.status !== 'cancelled') r.job.status = 'failed'; r.job.error = e.error; finishRun(r); break; }
    default: break; // log lines stay in the engine log
  }
}
function onJobUpdate(r) {
  if (r.done) return;
  const beat = beatOf(r.job);
  if (beat !== r.beat) { applyBeat(r, beat); renderRun(r); } else updateMeta(r);
}
function applyBeat(r, beat) {
  const changed = r.beat && r.beat !== beat;
  r.beat = beat;
  steps.set(beat);
  setPill(beat.toUpperCase());
  setState(beat);
  if (changed && LINES[beat]) say(LINES[beat]);
}
// the engine publishes a first, pre-polish version of the site as soon as it can
async function earlyPreview(r) {
  const latest = await api.job(r.job.id).catch(() => null);
  if (!latest?.siteUrl || r.done || r.earlyPreview) return;
  r.earlyPreview = true;
  r.job = { ...r.job, siteUrl: latest.siteUrl, slug: latest.slug ?? r.job.slug, preview: true };
  showPreview(latest.siteUrl, latest.slug || 'your store', { polishing: true });
  renderRun(r);
  say(LINES.firstVersion);
}
async function loadCoverage(r) {
  const c = await api.coverage(r.job.id).catch(() => null);
  if (!c) return;
  r.coverage = c;
  if (r.done) renderRun(r);
}
async function finishRun(r) {
  if (r.done) return;
  r.done = true;
  detach();
  setBusy(false);
  const job = r.job;
  if (job.status === 'done') {
    const siteUrl = siteUrlOf(job);
    steps.set('live');
    setPill('LIVE');
    setState('idle');
    if (siteUrl) showPreview(siteUrl, job.slug || 'your store', { reload: r.earlyPreview });
    say(siteUrl ? LINES.live : LINES.dataReady);
    await loadCoverage(r);
  } else {
    steps.reset();
    idle();
    say(job.status === 'cancelled' ? LINES.cancelled : LINES.stopped);
  }
  renderRun(r);
  input.focus();
}

// ---------- rendering the build inside the conversation ----------
function siteUrlOf(job) {
  if (job.siteUrl) return job.siteUrl;
  return job.status === 'done' && job.slug && !job.input?.options?.skipBuild ? `/s/${job.slug}/` : null;
}
function metaText(r) {
  const job = r.job;
  const done = job.status === 'done';
  const failed = job.status === 'failed' || job.status === 'cancelled';
  const active = job.steps.find((s) => s.status === 'running');
  const parts = [];
  if (done) parts.push(siteUrlOf(job) ? 'Live' : 'Data ready');
  else if (failed) parts.push(job.status === 'cancelled' ? 'Cancelled' : 'Failed');
  else if (active) parts.push(r.progress[active.name] ? `${STEP_LABELS[active.name] ?? active.name} — ${r.progress[active.name]}` : STEP_LABELS[active.name] ?? active.name);
  else parts.push(job.status === 'queued' ? 'Queued' : 'Starting');
  if (!done && !failed) {
    const elapsed = Math.max(0, Date.now() - new Date(job.createdAt).getTime());
    const eta = remainingMs(job.steps);
    parts.push(humanDuration(elapsed) + (eta > 30_000 ? ` · about ${humanDuration(eta)} left` : ''));
  }
  return parts.join(' · ');
}
function updateMeta(r) {
  const m = r.bubble.querySelector('[data-meta]');
  if (m) m.textContent = metaText(r);
}
function safeImage(u) { return typeof u === 'string' && /^(https?:\/\/|\/)/.test(u) ? u : null; }
function peekHtml(found) {
  const cards = found.products.slice(0, 8).map((p) => {
    const img = safeImage(p.image);
    return `<figure>${img ? `<img src="${esc(img)}" alt="" loading="lazy">` : '<span class="ph"></span>'}<figcaption>${esc(p.title)}${p.priceText ? `<small>${esc(p.priceText)}</small>` : ''}</figcaption></figure>`;
  });
  const more = found.total - Math.min(found.products.length, 8);
  return `<div class="peek">${cards.join('')}${more > 0 ? `<span class="more">+${more}</span>` : ''}</div>`;
}
function coverageHtml(c) {
  const t = c.totals;
  const recos = (c.recommendations || []).slice(0, 1);
  return `<div class="coverage">${plural(t.products, 'product')} · ${t.withPrice} priced · ${t.withImages} with photos${recos.length ? `<ul>${recos.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}</div>`;
}
function renderRun(r) {
  const job = r.job;
  const done = job.status === 'done';
  const failed = job.status === 'failed' || job.status === 'cancelled';
  const running = !done && !failed;
  const siteUrl = siteUrlOf(job);
  const name = job.slug || 'your store';
  let prose = '';
  if (failed) prose = `${job.status === 'cancelled' ? 'Build cancelled.' : 'The build stopped.'}${job.error ? ` ${esc(job.error)}` : ''}`;
  else if (done && siteUrl) prose = `Your store is live${r.found ? ` with ${plural(r.found.total, 'product')}` : ''}.`;
  else if (done) prose = 'The store data is ready. No site was built.';
  const actions = [
    running ? '<button type="button" class="ghost" data-action="cancel">CANCEL</button>' : '',
    siteUrl ? `<button type="button" data-action="preview" data-url="${esc(siteUrl)}" data-name="${esc(name)}">PREVIEW</button><button type="button" class="ghost" data-action="open" data-url="${esc(siteUrl)}">OPEN</button>` : '',
    done && !siteUrl && job.slug ? `<button type="button" class="ghost" data-action="open" data-url="/api/stores/${esc(job.slug)}">STORE DATA</button>` : '',
    done && job.slug ? `<button type="button" class="ghost" data-action="rebuild" data-slug="${esc(job.slug)}">REBUILD</button>` : '',
    failed ? '<button type="button" data-action="retry">TRY AGAIN</button>' : '',
  ].join('');
  r.bubble.classList.toggle('error', failed);
  r.bubble.innerHTML = `${prose ? `<p>${prose}</p>` : ''}
    <div class="build ${running ? 'working' : ''} ${failed ? 'failed' : ''}">
      <i></i><span class="name" title="${esc(name)}">${esc(name)}</span>
      <span class="meta" data-meta>${esc(metaText(r))}</span>
      <span class="actions">${actions}</span>
    </div>
    ${r.found ? peekHtml(r.found) : ''}
    ${r.coverage && !running ? coverageHtml(r.coverage) : ''}`;
  scrollDown();
}
// one delegated listener for every button rendered inside a bubble
messagesEl.addEventListener('click', async (e) => {
  const b = e.target.closest('button[data-action]');
  if (!b) return;
  const { action, url, name, slug } = b.dataset;
  if (action === 'preview') { showPreview(url, name); setPill('LIVE'); }
  else if (action === 'open') window.open(new URL(url, location.href).toString(), '_blank', 'noopener');
  else if (action === 'cancel' && run && !run.done) {
    b.disabled = true;
    await api.cancel(run.job.id).catch((err) => toast(err.message, 'warn'));
  } else if (action === 'rebuild') rebuild(slug);
  else if (action === 'retry' && lastInput) {
    input.value = lastInput.text;
    autosize();
    clearFiles();
    addFiles(lastInput.files);
    renderChips();
    input.focus();
  }
});

async function rebuild(slug) {
  if (isBusy) return;
  const templateId = optTemplate.value || null;
  addMessage('user').textContent = `Rebuild ${slug}${templateId ? ` with ${templateId}` : ''}`;
  const bubble = addMessage('ai');
  bubble.classList.add('cursor');
  setBusy(true);
  hidePreview();
  setState('building'); steps.set('building'); setPill('BUILDING');
  say(LINES.rebuilding);
  try {
    const job = await api.rebuild(slug, templateId);
    bubble.classList.remove('cursor');
    attach(job, bubble);
  } catch (err) {
    bubble.classList.remove('cursor');
    bubble.classList.add('error');
    bubble.textContent = err.message;
    steps.reset(); idle(); setBusy(false);
  }
}

async function send() {
  const raw = input.value.trim();
  if ((!raw && !picked.length) || isBusy) return;
  // one link per line: the engine reads the input line by line
  const text = raw.replace(/[ \t]+(?=https?:\/\/)/g, '\n');
  const files = picked.map((p) => p.file);
  lastInput = { text, files };

  const ub = addMessage('user');
  ub.innerHTML = `${esc(text).replace(/\n/g, '<br>') || 'Screenshots'}${files.length ? `<small class="files-note">${plural(files.length, 'file')}: ${esc(files.map((f) => f.name).join(', '))}</small>` : ''}`;
  input.value = ''; autosize();
  clearFiles();
  renderChips();
  setBusy(true);
  hidePreview();

  const bubble = addMessage('ai');
  bubble.classList.add('cursor');
  setState('thinking'); steps.set('thinking'); setPill('THINKING');
  say(LINES.thinking);
  try {
    const job = await api.createJob(text, buildOptions(), files);
    bubble.classList.remove('cursor');
    attach(job, bubble);
  } catch (err) {
    bubble.classList.remove('cursor');
    bubble.classList.add('error');
    bubble.textContent = health ? err.message : 'The Nexova API is not reachable.';
    steps.reset(); idle(); setBusy(false);
  }
}

composer.addEventListener('submit', (e) => { e.preventDefault(); send(); });
input.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' || e.isComposing) return;
  e.preventDefault();
  if (!e.shiftKey) { send(); return; }
  // Shift+Enter: a new line (one link or product per line)
  input.setRangeText('\n', input.selectionStart, input.selectionEnd, 'end');
  input.dispatchEvent(new Event('input', { bubbles: true }));
});

// keyboard: Esc closes the preview
window.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !preview.hidden) hidePreview(); });

// ---------- boot ----------
window.nexo = { head, HeadState, api, voice }; // console access: nexo.head.setState('thinking'), nexo.voice.say('…')

const [h, t] = await Promise.allSettled([api.health(), api.templates()]);
applyHealth(h.status === 'fulfilled' ? h.value : null);
// NEXOVA AI's own voice when the server has one; the lines it will say are fetched ahead
voice.tts = !!health?.voice;
await voice.load(Object.values(LINES)); // the greeting must know its clip exists
if (t.status === 'fulfilled') fillTemplates(t.value);

addMessage('ai').innerHTML = '<p>Paste your TikTok Shop or Shopee link. Your store goes live here.</p>';
renderChips();
setTimeout(() => { if (!run) say(LINES.greeting); }, 900);

// resume a build from the URL (?job=…), like the classic home
const resumeId = new URLSearchParams(location.search).get('job');
if (resumeId) {
  api.job(resumeId).then((job) => {
    addMessage('user').innerHTML = esc(job.input?.raw || '').replace(/\n/g, '<br>') || 'Screenshots';
    attach(job, addMessage('ai'));
  }).catch(() => history.replaceState(null, '', location.pathname));
}
