// head.js — the NEXOVA AI head: the reference render itself (img/helmet.webp, cut from the
// design reference) with a floor shadow and an SVG layer over the visor that carries the life:
// the blue line breathes, ignites on boot, becomes a waveform while it speaks, and a soft light
// sweeps the glass while it thinks / designs / builds. The head floats and leans toward the cursor.
//
// Same surface the old hologram had: setState(), setAudioLevel(), pulse(), paused.

export const HeadState = {
  IDLE: 'idle',
  LISTENING: 'listening',
  THINKING: 'thinking',
  DESIGNING: 'designing',
  BUILDING: 'building',
  SPEAKING: 'speaking',
};

// The visor line in the reference, in the overlay's coordinate space (the helmet image is
// 1093 × 873): a shallow smile from (311, 610) through (545, 635) to (779, 610).
const ARC = { x0: 311, y0: 610.5, x1: 779, y1: 610.5, cx: 545, cy: 660 };
const ARC_PATH = `M${ARC.x0},${ARC.y0} Q${ARC.cx},${ARC.cy} ${ARC.x1},${ARC.y1}`;

function arcPoint(t) {
  const u = 1 - t;
  return {
    x: u * u * ARC.x0 + 2 * u * t * ARC.cx + t * t * ARC.x1,
    y: u * u * ARC.y0 + 2 * u * t * ARC.cy + t * t * ARC.y1,
  };
}

export class Head {
  constructor(root) {
    this.root = root;
    this.tilt = root.querySelector('.head-tilt');
    this.line = root.querySelector('.fx-line');
    this.glow = root.querySelector('.fx-glow');
    this.state = HeadState.IDLE;
    this.audioLevel = 0;
    this.energy = 0;
    this._paused = false;
    this._mouse = { x: 0, y: 0 };
    this._lean = { x: 0, y: 0 };
    this._t = 0;
    this._raf = 0;
    this._last = performance.now();

    this._onMove = (e) => {
      const r = this.root.getBoundingClientRect();
      const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
      this._mouse.x = Math.max(-1, Math.min(1, (e.clientX - cx) / (window.innerWidth / 2)));
      this._mouse.y = Math.max(-1, Math.min(1, (e.clientY - cy) / (window.innerHeight / 2)));
    };
    window.addEventListener('pointermove', this._onMove, { passive: true });
    this._reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    requestAnimationFrame(() => root.classList.add('booted'));
    this._raf = requestAnimationFrame((now) => this._frame(now));
  }

  setState(s) {
    this.state = s;
    this.root.dataset.state = s;
    if (s !== HeadState.SPEAKING) this._drawLine(0);
  }
  setAudioLevel(v = 0) { this.audioLevel = Math.max(0, Math.min(1, v)); }
  /** a brief flash of the visor line, e.g. when a progress message lands */
  pulse(amount = 0.4) { this.energy = Math.min(1, this.energy + amount); }

  get paused() { return this._paused; }
  set paused(v) {
    this._paused = !!v;
    this.root.classList.toggle('paused', this._paused);
  }

  _frame(now) {
    this._raf = requestAnimationFrame((n) => this._frame(n));
    const dt = Math.min(0.1, (now - this._last) / 1000);
    this._last = now;
    if (this._paused) return;
    this._t += dt;

    // lean toward the cursor, gently
    if (!this._reduced) {
      const dx = this._mouse.x - this._lean.x, dy = this._mouse.y - this._lean.y;
      if (Math.abs(dx) > 0.001 || Math.abs(dy) > 0.001) {
        this._lean.x += dx * Math.min(1, dt * 3);
        this._lean.y += dy * Math.min(1, dt * 3);
        this.tilt.style.transform = `perspective(1400px) rotateY(${(this._lean.x * 5).toFixed(2)}deg) rotateX(${(-this._lean.y * 3.5).toFixed(2)}deg)`;
      }
    }

    // the flash decays; the line brightens with it
    if (this.energy > 0) {
      this.energy = Math.max(0, this.energy - dt * 1.6);
      this.root.style.setProperty('--flash', this.energy.toFixed(3));
    }

    // while speaking the line is a waveform driven by the voice
    if (this.state === HeadState.SPEAKING) this._drawLine(this.audioLevel);
  }

  _drawLine(level) {
    if (level <= 0.001) {
      if (this.line.getAttribute('d') !== ARC_PATH) { this.line.setAttribute('d', ARC_PATH); this.glow.setAttribute('d', ARC_PATH); }
      return;
    }
    const n = 48;
    const amp = 5 + level * 26;
    const t = this._t;
    let d = '';
    for (let i = 0; i <= n; i++) {
      const u = i / n;
      const p = arcPoint(u);
      const taper = Math.sin(u * Math.PI);                                  // still at both ends
      const wave = Math.sin(u * 22 + t * 14) * 0.6 + Math.sin(u * 9 - t * 9) * 0.4;
      const y = p.y + wave * amp * taper;
      d += (i ? ' L' : 'M') + p.x.toFixed(1) + ',' + y.toFixed(1);
    }
    this.line.setAttribute('d', d);
    this.glow.setAttribute('d', d);
  }

  dispose() {
    cancelAnimationFrame(this._raf);
    window.removeEventListener('pointermove', this._onMove);
  }
}
