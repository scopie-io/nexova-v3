// voice.js — how the head talks.
//
// Every line is shown word by word beside the head while the visor line moves as a waveform.
// The sound, in order of preference:
//   1. a recorded clip shipped with the page (voice/<slug>.mp3; voice/manifest.json lists each
//      clip with the seconds its speech starts and ends) — one natural voice everywhere, no
//      service, no latency;
//   2. the server's voice (/api/tts, Qwen3-TTS) for a line that has no clip;
//   3. the browser's own speech engine.
// The words follow the audio's progress, and with the browser engine its word boundaries.
// Browsers only play audio after the first click or key, so a line said before that is read
// out silently and voiced on the first interaction if it is still the one on screen.

import { HeadState } from './head.js';

const slug = (text) => text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);

export class Voice {
  /**
   * @param head    the Head
   * @param el      where the words appear
   * @param restore () => the state the head should return to when the line ends
   */
  constructor(head, el, restore) {
    this.head = head;
    this.el = el;
    this.restore = restore;
    this.sound = true;
    this.tts = false;            // the server has /api/tts
    this._manifest = null;       // slug -> { start, end, duration } for the recorded clips
    this._ttsDownUntil = 0;
    this._clips = new Map();     // text -> Promise<Blob | null>
    this._token = 0;
    this._raf = 0;
    this._current = null;        // { token, pending } while a line is up
    this._audio = new Audio();
    this._audio.preload = 'auto';
    this._ctx = null; this._analyser = null; this._data = null;

    // the first interaction unlocks audio: voice the line that is still on screen, if any
    const unlock = () => {
      if (this._ctx?.state === 'suspended') this._ctx.resume().catch(() => {});
      if (this._current?.pending) this._current.pending();
    };
    window.addEventListener('pointerdown', unlock, { passive: true });
    window.addEventListener('keydown', unlock);
  }

  /** which lines have a recorded clip (awaited), then warm the clips: the first line now, the rest when idle */
  async load(lines) {
    try {
      const r = await fetch('/v2/voice/manifest.json');
      this._manifest = new Map(Object.entries(r.ok ? await r.json() : {}));
    } catch { this._manifest = new Map(); }
    const [first, ...rest] = lines;
    if (first) this._clip(first);
    if (navigator.connection?.saveData) return;
    const warm = async () => {
      for (const t of rest) {
        if (this._manifest.has(slug(t))) { this._clip(t); continue; }
        if (!this.tts || Date.now() < this._ttsDownUntil) continue;
        if (!(await this._clip(t))) break; // the service is unhappy: stop asking
      }
    };
    if ('requestIdleCallback' in window) requestIdleCallback(() => warm(), { timeout: 4000 });
    else setTimeout(warm, 2500);
  }

  say(text) {
    this.stop();
    const token = ++this._token;
    const head = this.head;
    const el = this.el;
    el.textContent = '';
    el.classList.add('show');
    head.setState(HeadState.SPEAKING);

    let revealed = 0;
    const reveal = (n) => {
      if (n <= revealed) return;
      revealed = Math.min(text.length, n);
      el.textContent = text.slice(0, revealed);
    };
    const rest = () => {
      cancelAnimationFrame(this._raf);
      this._raf = 0;
      head.setAudioLevel(0);
      head.setState(this.restore());
    };
    const finish = () => {
      if (token !== this._token) return;
      reveal(text.length);
      rest();
    };

    // no audio to measure: a synthetic amplitude
    const t0 = performance.now();
    const synth = (now) => {
      if (token !== this._token) return;
      const s = (now - t0) / 1000;
      head.setAudioLevel(0.3 + 0.25 * Math.abs(Math.sin(s * 9.3)) + 0.2 * Math.abs(Math.sin(s * 23.7)));
      this._raf = requestAnimationFrame(synth);
    };

    // the words at a pace: reading speed when silent, speaking speed beside a voice with no word events
    let typing = false, voiced = false;
    const typewriter = (msPerChar = 34) => {
      if (typing || token !== this._token) return;
      typing = true;
      if (!this._raf) this._raf = requestAnimationFrame(synth);
      const start = performance.now();
      const step = (now) => {
        if (token !== this._token || h.audio) return; // a clip took over: the words follow it instead
        const n = Math.min(text.length, Math.floor((now - start) / msPerChar));
        reveal(n);
        if (n < text.length) requestAnimationFrame(step);
        else if (!voiced) setTimeout(finish, 420);
      };
      requestAnimationFrame(step);
    };

    this._current = { token, pending: null };
    const h = { reveal, finish, rest, typewriter, audio: false, onVoiced: () => { voiced = true; } };

    if (!this.sound) { typewriter(); return; }
    const recorded = this._manifest?.has(slug(text));
    if (recorded || (this.tts && Date.now() > this._ttsDownUntil)) this._sayWithClip(text, token, h);
    else this._sayWithBrowser(text, token, h);
  }

  // ---- a recorded clip, or the server's voice ----
  _clip(text) {
    if (!this._clips.has(text)) {
      const recorded = this._manifest?.has(slug(text));
      const req = recorded
        ? fetch(`/v2/voice/${slug(text)}.mp3`)
        : fetch('/api/tts', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }) });
      this._clips.set(text, req
        .then((r) => {
          if (r.ok) return r.blob();
          if (!recorded) {
            if (r.status === 503) this.tts = false;                       // no voice on this server
            else this._ttsDownUntil = Date.now() + 5 * 60_000;             // quota / upstream trouble: rest it a while
          }
          return null;
        })
        .catch(() => { if (!recorded) this._ttsDownUntil = Date.now() + 60_000; return null; }));
    }
    return this._clips.get(text);
  }
  async _sayWithClip(text, token, h) {
    // the words start on their own if the clip takes a moment
    const slow = setTimeout(() => h.typewriter(), 900);
    const blob = await this._clip(text);
    clearTimeout(slow);
    if (token !== this._token) return;
    if (!blob) { this._sayWithBrowser(text, token, h); return; }

    const url = URL.createObjectURL(blob);
    const audio = this._audio;
    const timing = this._manifest?.get(slug(text)); // the spoken part of a recorded clip
    const play = async () => {
      if (token !== this._token) return;
      audio.src = url;
      audio.onended = () => { URL.revokeObjectURL(url); h.finish(); h.rest(); };
      audio.onerror = () => { URL.revokeObjectURL(url); h.finish(); h.rest(); };
      await audio.play(); // rejects while autoplay is still blocked: nothing below runs then
      if (token !== this._token) { audio.pause(); return; }
      h.onVoiced();
      h.audio = true;
      // the real amplitude, once the page has been interacted with (a context made earlier stays silent)
      if (navigator.userActivation?.hasBeenActive !== false) this._graph();
      if (this._ctx?.state === 'suspended') this._ctx.resume().catch(() => {});
      this.head.setState(HeadState.SPEAKING); // a late (unlocked) playback brings it back from rest
      const t0 = performance.now();
      const loop = (now) => {
        if (token !== this._token) return;
        if (this._analyser) {
          this._analyser.getByteFrequencyData(this._data);
          let sum = 0;
          for (const v of this._data) sum += v;
          this.head.setAudioLevel(Math.min(1, (sum / this._data.length / 255) * 2.2));
        } else {
          const s = (now - t0) / 1000;
          this.head.setAudioLevel(0.3 + 0.25 * Math.abs(Math.sin(s * 9.3)) + 0.2 * Math.abs(Math.sin(s * 23.7)));
        }
        // the words follow the voice, a beat ahead so a word is on screen as it is heard
        const from = timing?.start ?? 0, to = timing?.end ?? audio.duration;
        if (to > from) h.reveal(Math.floor(text.length * Math.min(1, Math.max(0, audio.currentTime + 0.22 - from) / (to - from))));
        this._raf = requestAnimationFrame(loop);
      };
      cancelAnimationFrame(this._raf);
      this._raf = requestAnimationFrame(loop);
    };
    try {
      await play();
    } catch {
      // autoplay is blocked until the first click or key: read it out now, voice it then if still on screen
      h.typewriter();
      if (this._current?.token === token) this._current.pending = () => { this._current.pending = null; play().catch(() => {}); };
    }
  }
  _graph() {
    if (this._ctx) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    try {
      this._ctx = new AC();
      const src = this._ctx.createMediaElementSource(this._audio);
      this._analyser = this._ctx.createAnalyser();
      this._analyser.fftSize = 256;
      this._analyser.smoothingTimeConstant = 0.7;
      src.connect(this._analyser);
      this._analyser.connect(this._ctx.destination);
      this._data = new Uint8Array(this._analyser.frequencyBinCount);
    } catch { this._ctx = null; }
  }

  // ---- the browser's own voice ----
  _sayWithBrowser(text, token, h) {
    if (!('speechSynthesis' in window)) { h.typewriter(); return; }
    const u = new SpeechSynthesisUtterance(text);
    u.rate = 0.97;
    u.pitch = 1;
    u.voice = pickVoice();
    let started = false, boundaries = false;
    u.onstart = () => {
      started = true;
      h.onVoiced();
      if (!this._raf) this._raf = requestAnimationFrame((now) => this._synthFrom(now, token));
      // no word events from this voice: pace the words at speaking speed instead
      setTimeout(() => { if (!boundaries) h.typewriter(62); }, 400);
    };
    u.onboundary = (e) => { boundaries = true; if (token === this._token && e.name === 'word') h.reveal(e.charIndex + (e.charLength || 0)); };
    u.onend = h.finish;
    u.onerror = () => { if (!started) h.typewriter(); else h.finish(); };
    this._u = u;
    try { speechSynthesis.speak(u); } catch { h.typewriter(); }
    // nothing started (blocked until the first interaction, or no voices): read it out visually
    setTimeout(() => { if (token === this._token && !started) h.typewriter(); }, 1200);
  }
  _synthFrom(now, token) {
    const t0 = now;
    const tick = (n) => {
      if (token !== this._token) return;
      const s = (n - t0) / 1000;
      this.head.setAudioLevel(0.3 + 0.25 * Math.abs(Math.sin(s * 9.3)) + 0.2 * Math.abs(Math.sin(s * 23.7)));
      this._raf = requestAnimationFrame(tick);
    };
    tick(now);
  }

  stop() {
    this._token++;
    cancelAnimationFrame(this._raf);
    this._raf = 0;
    this._current = null;
    try { this._audio.pause(); } catch { /* ignore */ }
    if (this._u) { try { speechSynthesis.cancel(); } catch { /* ignore */ } this._u = null; }
    this.head.setAudioLevel(0);
    if (this.head.state === HeadState.SPEAKING) this.head.setState(this.restore());
  }
}

// the most natural English voice this browser has: neural / online voices first, then the clearest classics
function pickVoice() {
  const voices = speechSynthesis.getVoices();
  const en = voices.filter((v) => /^en/i.test(v.lang));
  const rank = (v) => {
    const n = v.name;
    if (/Natural|Neural/i.test(n)) return 0;
    if (/Online/i.test(n) || !v.localService) return 1;
    if (/Google/i.test(n)) return 2;
    if (/Samantha|Karen|Moira|Tessa|Daniel|Zira/i.test(n)) return 3;
    if (/Mark/i.test(n)) return 4;
    return 5;
  };
  return en.sort((a, b) => rank(a) - rank(b))[0] || voices[0] || null;
}
