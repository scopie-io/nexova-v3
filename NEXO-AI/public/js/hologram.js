// hologram.js — NEXOVA AI as a living hologram, built procedurally in Three.js.
// Modelled element-by-element on design/helmet-reference.png:
//   · squircle pod dome (superellipsoid) with a knit/hatch holographic texture,
//     white on the crown fading to blue on the sides, a crown seam
//   · a wide beveled chrome bezel around a rounded-rectangle visor
//   · near-black glass with an inner rim light and a bold blue visor line
//     (a smile at rest → the voice waveform when speaking)
//   · three stacked discs per ear pod with chrome edge rings
//   · a thick platform: glowing top rings, a data-ruler band on the side,
//     an outer floor ring, thin light rays rising, a floor reflection
//   · particles, contained bloom, glitches, sheen, glints, boot-up
// Reactive states: idle / listening / thinking / designing / building / speaking.
//
// Same lineage as TRI-BRAIN's brain3d.js — the procedural, bloom-lit JARVIS
// approach (cam-hm/jarvis arc reactor, ostepan8/jarvis-web-interface).

import * as THREE from 'three';

export const HoloState = {
  IDLE: 'idle', LISTENING: 'listening', THINKING: 'thinking',
  DESIGNING: 'designing', BUILDING: 'building', SPEAKING: 'speaking',
};

// ---------- proportions (from the reference; 1 unit ≈ 280px of the 1297px image) ----------
const RX = 1.25, RY = 1.19, RZ = 1.04;      // dome radii
const DOME_N = 2.35;                         // superellipsoid exponent: 2 = sphere, higher = squarer pod
const VISOR = { a: 0.80, b: 0.64, n: 3.0, cy: -0.20 };   // rounded-rectangle opening in the dome's front

// ---------- geometry helpers ----------
// Sphere → superellipsoid (|x|^n + |y|^n + |z|^n = 1): flatter front, sides and bottom.
function superSphereGeometry(n, wSeg = 192, hSeg = 128) {
  const geo = new THREE.SphereGeometry(1, wSeg, hSeg);
  const pos = geo.attributes.position;
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i).normalize();
    const r = 1 / Math.pow(Math.pow(Math.abs(v.x), n) + Math.pow(Math.abs(v.y), n) + Math.pow(Math.abs(v.z), n), 1 / n);
    pos.setXYZ(i, v.x * r, v.y * r, v.z * r);
  }
  geo.computeVertexNormals();
  return geo;
}
const surfZ = (x, y) => Math.pow(Math.max(0, 1 - Math.pow(Math.abs(x), DOME_N) - Math.pow(Math.abs(y), DOME_N)), 1 / DOME_N);

// The visor opening as a 3D curve on the dome surface. `grow` widens the
// rounded rectangle (for the bezel's outer lip), `lift` raises it off the surface.
class VisorCurve extends THREE.Curve {
  constructor(grow = 1, lift = 1) { super(); this.grow = grow; this.lift = lift; }
  getPoint(t, target = new THREE.Vector3()) {
    const th = t * Math.PI * 2;
    const c = Math.cos(th), s = Math.sin(th);
    const x = VISOR.a * this.grow * Math.sign(c) * Math.pow(Math.abs(c), 2 / VISOR.n);
    const y = VISOR.cy + VISOR.b * this.grow * Math.sign(s) * Math.pow(Math.abs(s), 2 / VISOR.n);
    const z = surfZ(x, y);
    return target.set(x * RX * this.lift, y * RY * this.lift, z * RZ * this.lift);
  }
}

// ---------- shared GLSL ----------
const COMMON_VERT = /* glsl */`
  uniform float uTime;
  uniform float uGlitch;
  varying vec3 vPos;
  varying vec3 vVN;
  varying vec3 vVP;
  varying vec2 vUv;
  void main() {
    vPos = position;
    vUv = uv;
    vec3 p = position;
    float band = step(0.84, fract(p.y * 2.7 + uTime * 9.0));
    p.x += uGlitch * band * 0.05;
    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    vVN = normalize(normalMatrix * normal);
    vVP = mv.xyz;
    gl_Position = projectionMatrix * mv;
  }
`;
const GLSL_UTIL = /* glsl */`
  float hash(float n) { return fract(sin(n) * 43758.5453); }
  float hash2(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float visorD(vec3 p) {
    vec2 e = vec2(abs(p.x) / ${VISOR.a.toFixed(3)}, abs(p.y - (${VISOR.cy.toFixed(3)})) / ${VISOR.b.toFixed(3)});
    return pow(e.x, ${VISOR.n.toFixed(2)}) + pow(e.y, ${VISOR.n.toFixed(2)});
  }
`;

// The shell: knit rows + hatch columns, white crown → blue sides, soft fresnel,
// crown seam, sheen, scanlines, thinking sweep, visor cut-out, boot reveal.
const shellFrag = /* glsl */`
  uniform float uTime, uIntensity, uScan, uScanOn, uLevel, uGridBoost, uReveal, uSheen;
  uniform vec3 uColor, uColor2;
  varying vec3 vPos, vVN, vVP; varying vec2 vUv;
  ${GLSL_UTIL}
  void main() {
    float revealY = mix(-1.35, 1.35, uReveal);
    if (vPos.y > revealY) discard;
    float revealEdge = exp(-(revealY - vPos.y) * 10.0) * step(uReveal, 0.999);

    float bezelGlow = 0.0;
    #ifdef VISOR_MASK
    if (vPos.z > 0.0) {
      float d = visorD(vPos);
      if (d < 1.0) discard;
      bezelGlow = 1.0 - smoothstep(1.0, 1.45, d);
    }
    #endif

    vec3 N = normalize(vVN);
    vec3 V = normalize(-vVP);
    float ndv = max(dot(N, V), 0.0);
    float fres = pow(1.0 - ndv, 2.2);
    float lam = max(dot(N, normalize(vec3(0.1, 0.9, 0.45))), 0.0);

    // woven texture: knit rows + fine hatch columns, plus a little grain
    float rows = 0.5 + 0.5 * sin(vUv.y * 560.0);
    float cols = 0.5 + 0.5 * sin(vUv.x * 1400.0);
    float knit = smoothstep(0.35, 0.95, rows) * 0.22 + smoothstep(0.5, 1.0, cols) * 0.04;
    float grain = hash2(floor(vUv * vec2(900.0, 450.0)) + floor(uTime * 8.0)) * 0.04;
    // soft holographic mesh — brightens while building
    vec2 g = abs(fract(vUv * vec2(48.0, 24.0)) - 0.5);
    float grid = (1.0 - smoothstep(0.0, 0.10, min(g.x, g.y))) * (0.045 + uGridBoost);
    float scan = smoothstep(0.92, 1.0, sin(vPos.y * 48.0 - uTime * 1.8)) * 0.07;
    float sheen = exp(-pow((vPos.x + vPos.y * 0.45 - uSheen) * 2.6, 2.0)) * 0.16;
    float sweep = exp(-pow((vPos.y - uScan) * 4.0, 2.0)) * uScanOn * 0.5;
    float seam = (1.0 - smoothstep(0.004, 0.02, abs(vPos.x))) * smoothstep(-0.1, 0.3, vPos.y) * step(0.0, vPos.z) * 0.7;
    float flick = 0.975 + 0.025 * sin(uTime * 41.0) * sin(uTime * 17.0 + 1.3);

    float body = 0.22 + 0.42 * lam;
    float lum = body + fres * 0.35 + knit * (0.5 + 0.5 * lam) + grain + grid + scan + sheen + sweep + seam + bezelGlow * 0.35 + revealEdge * 2.0;
    vec3 tint = mix(uColor2, uColor, clamp(lam * 0.8 + fres * 0.3 + seam, 0.0, 1.0));
    tint = mix(tint, vec3(1.0), clamp(lam * lam * 0.5 + seam * 0.5 + revealEdge, 0.0, 1.0));
    gl_FragColor = vec4(tint * lum * uIntensity * flick * (1.0 + uLevel * 0.3), 1.0);
  }
`;

// Opaque chrome: dark blue body, bright top highlight, fresnel edge, specular.
const chromeFrag = /* glsl */`
  uniform float uIntensity, uReveal;
  uniform vec3 uColor, uColor2;
  varying vec3 vPos, vVN, vVP; varying vec2 vUv;
  void main() {
    float revealY = mix(-1.35, 1.35, uReveal);
    if (vPos.y > revealY) discard;
    vec3 N = normalize(vVN);
    vec3 V = normalize(-vVP);
    float ndv = max(dot(N, V), 0.0);
    float fres = pow(1.0 - ndv, 2.0);
    float top = pow(max(N.y, 0.0), 2.0);
    vec3 L = normalize(vec3(0.2, 0.9, 0.5));
    float spec = pow(max(dot(reflect(-L, N), V), 0.0), 40.0);
    vec3 col = vec3(0.05, 0.09, 0.16) + uColor2 * (0.22 + fres * 0.35) + uColor * top * 0.65 + vec3(1.0) * spec * 0.7;
    gl_FragColor = vec4(col * uIntensity, 1.0);
  }
`;

// Near-black visor glass with an inner rim light and a faint top reflection.
const glassFrag = /* glsl */`
  uniform float uTime;
  uniform vec3 uColor2;
  varying vec3 vPos, vVN, vVP; varying vec2 vUv;
  ${GLSL_UTIL}
  void main() {
    vec3 N = normalize(vVN);
    vec3 V = normalize(-vVP);
    float ndv = max(dot(N, V), 0.0);
    float fres = pow(1.0 - ndv, 3.0);
    float d = visorD(vPos);
    float rim = smoothstep(0.62, 1.02, d) * (0.25 + 0.75 * max(N.y, 0.0));
    float refl = smoothstep(0.2, 0.95, N.y) * 0.05;
    float lines = 0.5 + 0.5 * sin(vUv.x * 600.0);
    vec3 col = vec3(0.006, 0.010, 0.022) + uColor2 * (fres * 0.25 + rim * 0.45) + vec3(refl) + uColor2 * lines * 0.004;
    gl_FragColor = vec4(col, 1.0);
  }
`;

// Dark body with a soft blue fresnel (pod faces, platform lid).
const darkFrag = /* glsl */`
  uniform vec3 uColor2;
  varying vec3 vPos, vVN, vVP; varying vec2 vUv;
  void main() {
    float fres = pow(1.0 - max(dot(normalize(vVN), normalize(-vVP)), 0.0), 2.5);
    gl_FragColor = vec4(vec3(0.008, 0.012, 0.022) + uColor2 * fres * 0.3, 1.0);
  }
`;

// Platform side: dark band, a ruler of bright dashes along the middle, edge lines.
const bandFrag = /* glsl */`
  uniform float uTime, uIntensity;
  uniform vec3 uColor2;
  varying vec3 vPos, vVN, vVP; varying vec2 vUv;
  ${GLSL_UTIL}
  void main() {
    float u = vUv.x * 300.0;
    float id = floor(u);
    float h = hash(id + 3.0);
    float dash = step(0.45, fract(u)) * step(0.25, h);
    float height = 0.12 + 0.35 * h;
    float inBand = step(abs(vUv.y - 0.5), height * 0.5);
    float scroll = 0.5 + 0.5 * sin(id * 0.9 - uTime * 3.5);
    float edges = smoothstep(0.08, 0.0, vUv.y) * 0.5 + smoothstep(0.92, 1.0, vUv.y) * 0.9;
    float i = dash * inBand * (0.4 + 0.6 * scroll) * 0.9 + edges;
    gl_FragColor = vec4(vec3(0.008, 0.012, 0.022) + uColor2 * i * uIntensity, 1.0);
  }
`;

// Soft outer aura (fresnel only).
const auraFrag = /* glsl */`
  uniform vec3 uColor2;
  uniform float uIntensity;
  varying vec3 vPos, vVN, vVP; varying vec2 vUv;
  void main() {
    float fres = pow(1.0 - max(dot(normalize(vVN), normalize(-vVP)), 0.0), 3.4);
    gl_FragColor = vec4(uColor2 * fres * uIntensity, 1.0);
  }
`;

// The visor line: a bold smile at rest, a voice waveform when speaking,
// a travelling spark when thinking, a slow breath when listening, a glint now and then.
const flatVert = /* glsl */`
  varying vec2 vUv;
  void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
`;
const smileFrag = /* glsl */`
  uniform float uTime, uLevel, uMode, uGlint, uReveal;
  varying vec2 vUv;
  void main() {
    vec2 p = (vUv - 0.5) * 2.0;
    float x = p.x;
    float curve = -0.14 + 0.26 * x * x;
    float w = 0.0;
    if (uLevel > 0.001) {
      w = sin(x * 14.0 + uTime * 18.0) * 0.5 + sin(x * 23.0 - uTime * 27.0) * 0.3 + sin(x * 7.0 + uTime * 9.0) * 0.2;
      w *= uLevel * 0.9 * (1.0 - x * x);
    }
    float y = curve + w;
    float d = abs(p.y - y);
    float taper = 1.0 - smoothstep(0.8, 1.0, abs(x));
    float core = smoothstep(0.14, 0.03, d);
    float glow = exp(-d * 4.0) * 0.8;
    float spark = 0.0;
    if (uMode > 1.5 && uMode < 2.5) {
      float tx = sin(uTime * 2.4) * 0.85;
      spark = exp(-pow((x - tx) * 5.0, 2.0)) * exp(-d * 16.0) * 1.6;
    }
    float glint = exp(-pow((x - uGlint) * 7.0, 2.0)) * exp(-d * 14.0) * 1.0;
    float breathe = 1.0;
    if (uMode > 0.5 && uMode < 1.5) breathe = 0.7 + 0.3 * sin(uTime * 3.0);
    float i = (core + glow + spark + glint) * taper * breathe * uReveal;
    vec3 col = mix(vec3(0.20, 0.55, 1.0), vec3(0.50, 0.78, 1.0), core);
    gl_FragColor = vec4(col * i * (1.0 + uLevel * 1.4), 1.0);
  }
`;

// Platform top: glowing fill, concentric rings, a bright rim, a pulse ring.
const discFrag = /* glsl */`
  uniform float uTime, uIntensity, uPulse;
  uniform vec3 uColor2;
  varying vec2 vUv;
  void main() {
    vec2 p = (vUv - 0.5) * 2.0;
    float r = length(p);
    float a = atan(p.y, p.x);
    float core = exp(-r * 3.0) * 0.8;
    float fill = 0.10 * (1.0 - r * 0.5);
    float ring = 0.0;
    ring += smoothstep(0.012, 0.0, abs(r - 0.50)) * 0.7;
    ring += smoothstep(0.010, 0.0, abs(r - 0.66)) * 0.5;
    ring += smoothstep(0.014, 0.0, abs(r - 0.80)) * 0.9;
    ring += smoothstep(0.02, 0.0, abs(r - 0.94)) * 1.1;
    float seg = step(0.55, fract(a * 9.0 / 6.2831 + uTime * 0.05)) * smoothstep(0.03, 0.0, abs(r - 0.58)) * 0.5;
    float pulse = smoothstep(0.05, 0.0, abs(r - uPulse)) * (1.0 - uPulse) * 0.8;
    float edge = smoothstep(1.0, 0.96, r);
    gl_FragColor = vec4(uColor2 * (core + fill + ring + seg + pulse) * edge * uIntensity, 1.0);
  }
`;

// Volumetric haze between platform and helmet.
const beamFrag = /* glsl */`
  uniform float uTime, uIntensity;
  uniform vec3 uColor2;
  varying vec2 vUv;
  float hash(float n) { return fract(sin(n) * 43758.5453); }
  void main() {
    float col = floor(vUv.x * 220.0);
    float h = hash(col);
    float ray = smoothstep(0.55, 1.0, h);
    float run = 0.5 + 0.5 * sin(vUv.y * 30.0 - uTime * (2.5 + h * 3.0) + h * 10.0);
    float body = 0.10 + ray * 0.8 * run;
    float fadeTop = 1.0 - smoothstep(0.25, 1.0, vUv.y);
    float fadeBottom = smoothstep(0.0, 0.08, vUv.y);
    gl_FragColor = vec4(uColor2 * body * fadeTop * fadeBottom * uIntensity, 1.0);
  }
`;

// Particles: soft dots and tiny data squares, rising and twinkling.
const pointVert = /* glsl */`
  attribute float aSize, aPhase, aKind;
  uniform float uTime, uPixelRatio;
  varying float vAlpha, vKind;
  void main() {
    vKind = aKind;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mv;
    gl_PointSize = aSize * uPixelRatio * (520.0 / -mv.z);
    vAlpha = 0.45 + 0.55 * sin(uTime * (1.2 + aKind) + aPhase);
  }
`;
const pointFrag = /* glsl */`
  uniform vec3 uColor;
  uniform float uIntensity;
  varying float vAlpha, vKind;
  void main() {
    vec2 c = gl_PointCoord - 0.5;
    float shape = vKind > 0.5 ? step(max(abs(c.x), abs(c.y)), 0.42) : smoothstep(0.5, 0.05, length(c));
    gl_FragColor = vec4(uColor * shape * vAlpha * uIntensity, 1.0);
  }
`;

const ADD = { blending: THREE.AdditiveBlending, transparent: true, depthWrite: false };

export class Hologram {
  constructor(canvas, opts = {}) {
    this.canvas = canvas;
    this.color = new THREE.Color(opts.color || '#e4f0ff');
    this.color2 = new THREE.Color(opts.color2 || '#4f9dff');
    this.state = HoloState.IDLE;
    this.audioLevel = 0;
    this.energy = 0;
    this.mouse = { x: 0, y: 0 };
    this.glitch = 0;
    this._nextGlitch = 5;
    this._glitchEnd = 0;
    this._nextGlint = 3;
    this._glintStart = -10;
    this._t = 0;
    this.boot = 0;
    this.paused = false;
    // live-tunable look (also reachable from the console via window.nexo.holo.tune)
    this.tune = { bloom: 0.42, radius: 0.3, threshold: 0.55, shell: 0.75, chrome: 1.0, exposure: 0.85 };
    this.clock = new THREE.Clock();
    this._init();
  }

  async _init() {
    const w = this.canvas.clientWidth || 800;
    const h = this.canvas.clientHeight || 740;

    this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true, alpha: false, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
    this.renderer.setSize(w, h, false);
    this.renderer.setClearColor(0x000000, 1);          // black → dissolved by CSS screen blending
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = this.tune.exposure;

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(30, w / h, 0.1, 100);
    this.camera.position.set(0, 0.45, 10.2);
    this.camera.lookAt(0, -0.38, 0);

    this.rig = new THREE.Group();
    this.scene.add(this.rig);
    this.helmet = new THREE.Group();
    this.helmet.position.y = 0.32;
    this.rig.add(this.helmet);

    this.holoMats = [];
    this.chromeMats = [];
    this._buildHelmet();
    this._buildEars();
    this._buildPlatform();
    this._buildRays();
    this._buildParticles();

    await this._maybeBloom(w, h);

    this._onMove = (e) => {
      const r = this.canvas.getBoundingClientRect();
      const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
      this.mouse.x = Math.max(-1, Math.min(1, (e.clientX - cx) / (window.innerWidth / 2)));
      this.mouse.y = Math.max(-1, Math.min(1, (e.clientY - cy) / (window.innerHeight / 2)));
    };
    window.addEventListener('pointermove', this._onMove, { passive: true });
    this._ro = new ResizeObserver(() => this.resize());
    this._ro.observe(this.canvas.parentElement || this.canvas);

    this._animate();
  }

  _uniforms(extra = {}) {
    return {
      uTime: { value: 0 }, uGlitch: { value: 0 }, uIntensity: { value: 1 }, uReveal: { value: 0 },
      uColor: { value: this.color }, uColor2: { value: this.color2 },
      ...extra,
    };
  }
  _shellMaterial(withMask) {
    const m = new THREE.ShaderMaterial({
      vertexShader: COMMON_VERT, fragmentShader: shellFrag,
      uniforms: this._uniforms({ uScan: { value: 2 }, uScanOn: { value: 0 }, uLevel: { value: 0 }, uGridBoost: { value: 0 }, uSheen: { value: -3 } }),
      defines: withMask ? { VISOR_MASK: 1 } : {},
      side: THREE.FrontSide, ...ADD,
    });
    this.holoMats.push(m);
    return m;
  }
  _chromeMaterial() {
    const m = new THREE.ShaderMaterial({ vertexShader: COMMON_VERT, fragmentShader: chromeFrag, uniforms: this._uniforms() });
    this.chromeMats.push(m);
    return m;
  }
  _darkMaterial(frag = darkFrag, extra = {}) {
    return new THREE.ShaderMaterial({ vertexShader: COMMON_VERT, fragmentShader: frag, uniforms: this._uniforms(extra) });
  }

  _buildHelmet() {
    // near-black glass, just inside the shell
    this.glass = new THREE.Mesh(superSphereGeometry(DOME_N, 128, 96), this._darkMaterial(glassFrag));
    this.glass.scale.set(RX * 0.975, RY * 0.975, RZ * 0.975);
    this.helmet.add(this.glass);

    // the luminous shell with the visor cut out
    this.shell = new THREE.Mesh(superSphereGeometry(DOME_N), this._shellMaterial(true));
    this.shell.scale.set(RX, RY, RZ);
    this.shell.renderOrder = 2;
    this.helmet.add(this.shell);

    // beveled chrome bezel (opaque, sits on the shell) + thin bright inner and outer lips
    this.bezel = new THREE.Mesh(new THREE.TubeGeometry(new VisorCurve(1.03, 1.02), 260, 0.06, 16, true), this._chromeMaterial());
    this.helmet.add(this.bezel);
    const lipMat = new THREE.MeshBasicMaterial({ color: this.color, ...ADD, opacity: 0.9 });
    this.innerLip = new THREE.Mesh(new THREE.TubeGeometry(new VisorCurve(0.985, 1.0), 260, 0.010, 8, true), lipMat);
    this.outerLip = new THREE.Mesh(new THREE.TubeGeometry(new VisorCurve(1.085, 1.02), 260, 0.008, 8, true), lipMat.clone());
    this.outerLip.material.opacity = 0.55;
    this.innerLip.renderOrder = this.outerLip.renderOrder = 3;
    this.helmet.add(this.innerLip, this.outerLip);

    // soft outer aura
    this.aura = new THREE.Mesh(superSphereGeometry(DOME_N, 96, 64), new THREE.ShaderMaterial({
      vertexShader: COMMON_VERT, fragmentShader: auraFrag, uniforms: this._uniforms({ uIntensity: { value: 0.35 } }), ...ADD,
    }));
    this.aura.scale.set(RX * 1.07, RY * 1.07, RZ * 1.07);
    this.aura.renderOrder = 4;
    this.helmet.add(this.aura);

    // the visor line, drawn on top of the glass
    this.smile = new THREE.Mesh(new THREE.PlaneGeometry(1.45, 0.5), new THREE.ShaderMaterial({
      vertexShader: flatVert, fragmentShader: smileFrag,
      uniforms: { uTime: { value: 0 }, uLevel: { value: 0 }, uMode: { value: 0 }, uGlint: { value: -3 }, uReveal: { value: 0 } },
      depthTest: false, ...ADD,
    }));
    this.smile.position.set(0, -0.40, 0.9);
    this.smile.renderOrder = 5;
    this.helmet.add(this.smile);
  }

  _buildEars() {
    const mk = (dir) => {
      const g = new THREE.Group();
      g.position.set(dir * (RX * 0.97), -0.15, 0.0);
      // a disc: textured drum, dark face, chrome edge rings
      const disc = (r, len, off, edge) => {
        const drum = new THREE.Mesh(new THREE.CylinderGeometry(r, r, len, 96, 1, true), this._shellMaterial(false));
        drum.rotation.z = Math.PI / 2; drum.position.x = dir * (off + len / 2);
        const face = new THREE.Mesh(new THREE.CircleGeometry(r, 96), this._darkMaterial());
        face.rotation.y = dir * Math.PI / 2; face.position.x = dir * (off + len - 0.001);
        const e1 = new THREE.Mesh(new THREE.TorusGeometry(r, edge, 10, 128), this._chromeMaterial());
        e1.rotation.y = Math.PI / 2; e1.position.x = dir * (off + len);
        const e2 = new THREE.Mesh(new THREE.TorusGeometry(r, edge * 0.8, 10, 128), this._chromeMaterial());
        e2.rotation.y = Math.PI / 2; e2.position.x = dir * off;
        g.add(drum, face, e1, e2);
      };
      disc(0.52, 0.15, 0.00, 0.020);
      disc(0.37, 0.15, 0.15, 0.018);
      disc(0.22, 0.12, 0.30, 0.015);
      // concentric ring on the outer cap
      const cap = new THREE.Mesh(new THREE.TorusGeometry(0.13, 0.008, 8, 96), new THREE.MeshBasicMaterial({ color: this.color, ...ADD, opacity: 0.8 }));
      cap.rotation.y = Math.PI / 2; cap.position.x = dir * 0.425;
      g.add(cap);
      return g;
    };
    this.ears = [mk(-1), mk(1)];
    this.helmet.add(...this.ears);
  }

  _buildPlatform() {
    this.platform = new THREE.Group();
    this.platform.position.y = -1.62;
    this.scene.add(this.platform);

    // thick base: dark lid, data-ruler band around the side
    const lid = new THREE.Mesh(new THREE.CylinderGeometry(1.42, 1.44, 0.17, 160), this._darkMaterial());
    this.band = new THREE.Mesh(new THREE.CylinderGeometry(1.425, 1.445, 0.17, 160, 1, true), this._darkMaterial(bandFrag));
    this.platform.add(lid, this.band);

    // glowing top
    this.disc = new THREE.Mesh(new THREE.CircleGeometry(1.41, 128), new THREE.ShaderMaterial({
      vertexShader: flatVert, fragmentShader: discFrag,
      uniforms: { uTime: { value: 0 }, uIntensity: { value: 0.9 }, uPulse: { value: 2 }, uColor2: { value: this.color2 } }, ...ADD,
    }));
    this.disc.rotation.x = -Math.PI / 2; this.disc.position.y = 0.086;
    this.platform.add(this.disc);

    // rims: chrome top edge, thin glow below, outer floor ring
    const rim = new THREE.Mesh(new THREE.TorusGeometry(1.42, 0.016, 10, 240), this._chromeMaterial());
    rim.rotation.x = Math.PI / 2; rim.position.y = 0.085;
    const rimLow = new THREE.Mesh(new THREE.TorusGeometry(1.45, 0.007, 8, 240), new THREE.MeshBasicMaterial({ color: this.color2, ...ADD, opacity: 0.6 }));
    rimLow.rotation.x = Math.PI / 2; rimLow.position.y = -0.085;
    const outer = new THREE.Mesh(new THREE.TorusGeometry(1.62, 0.007, 8, 260), new THREE.MeshBasicMaterial({ color: this.color2, ...ADD, opacity: 0.7 }));
    outer.rotation.x = Math.PI / 2; outer.position.y = -0.03;
    this.platform.add(rim, rimLow, outer);

    // fine radial ticks just outside the rim
    const ticks = [];
    const N = 180;
    for (let i = 0; i < N; i++) {
      const a = (i / N) * Math.PI * 2;
      const len = 0.02 + Math.random() * (i % 9 === 0 ? 0.09 : 0.035);
      const r0 = 1.49, r1 = r0 + len;
      ticks.push(Math.cos(a) * r0, -0.03, Math.sin(a) * r0, Math.cos(a) * r1, -0.03, Math.sin(a) * r1);
    }
    const tg = new THREE.BufferGeometry();
    tg.setAttribute('position', new THREE.Float32BufferAttribute(ticks, 3));
    this.ticks = new THREE.LineSegments(tg, new THREE.LineBasicMaterial({ color: this.color2, ...ADD, opacity: 0.55 }));
    this.platform.add(this.ticks);

    // floor reflection
    const floor = new THREE.Mesh(new THREE.CircleGeometry(2.6, 64), new THREE.ShaderMaterial({
      vertexShader: flatVert,
      fragmentShader: /* glsl */`uniform vec3 uColor2; varying vec2 vUv;
        void main(){ vec2 p = (vUv-0.5)*2.0; float r = length(vec2(p.x, p.y*1.6)); gl_FragColor = vec4(uColor2 * exp(-r*3.2) * 0.2, 1.0); }`,
      uniforms: { uColor2: { value: this.color2 } }, ...ADD,
    }));
    floor.rotation.x = -Math.PI / 2; floor.position.y = -0.11;
    this.platform.add(floor);
  }

  _buildRays() {
    // thin crisp rays rising from the platform (fade at the top via vertex colour)
    const N = 140;
    const pos = [], col = [];
    const c = this.color2;
    for (let i = 0; i < N; i++) {
      const u = Math.random();
      const x = (Math.random() < 0.5 ? -1 : 1) * Math.sqrt(u) * 1.3;
      const z = (Math.random() - 0.5) * 1.2;
      const h = 0.6 + Math.random() * 2.2;
      const b = 0.25 + Math.random() * 0.75;
      pos.push(x, -1.53, z, x, -1.53 + h, z);
      col.push(c.r * b, c.g * b, c.b * b, 0, 0, 0);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    this.rays = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ vertexColors: true, ...ADD, opacity: 0.55 }));
    this.scene.add(this.rays);

    // soft volumetric haze
    const mk = (r0, r1, hgt, intensity) => {
      const m = new THREE.Mesh(new THREE.CylinderGeometry(r0, r1, hgt, 96, 1, true), new THREE.ShaderMaterial({
        vertexShader: flatVert, fragmentShader: beamFrag,
        uniforms: { uTime: { value: 0 }, uIntensity: { value: intensity }, uColor2: { value: this.color2 } },
        side: THREE.DoubleSide, ...ADD,
      }));
      m.position.y = -1.62 + 0.1 + hgt / 2;
      this.scene.add(m);
      return m;
    };
    this.beams = [mk(0.9, 1.35, 1.9, 0.18), mk(0.5, 0.85, 1.6, 0.16)];
  }

  _buildParticles() {
    const N = 520;
    const pos = new Float32Array(N * 3), size = new Float32Array(N), phase = new Float32Array(N), kind = new Float32Array(N);
    this._pSpeed = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      pos[i * 3] = (Math.random() - 0.5) * 5.2;
      pos[i * 3 + 1] = -1.8 + Math.random() * 4.6;
      pos[i * 3 + 2] = (Math.random() - 0.5) * 3.2;
      kind[i] = Math.random() < 0.3 ? 1 : 0;
      size[i] = kind[i] ? 0.045 + Math.random() * 0.05 : 0.02 + Math.random() * 0.04;
      phase[i] = Math.random() * Math.PI * 2;
      this._pSpeed[i] = 0.04 + Math.random() * 0.12;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
    g.setAttribute('aPhase', new THREE.BufferAttribute(phase, 1));
    g.setAttribute('aKind', new THREE.BufferAttribute(kind, 1));
    this.particles = new THREE.Points(g, new THREE.ShaderMaterial({
      vertexShader: pointVert, fragmentShader: pointFrag,
      uniforms: { uTime: { value: 0 }, uPixelRatio: { value: this.renderer.getPixelRatio() }, uColor: { value: this.color }, uIntensity: { value: 0.7 } },
      ...ADD,
    }));
    this.scene.add(this.particles);
  }

  async _maybeBloom(w, h) {
    try {
      const [{ EffectComposer }, { RenderPass }, { UnrealBloomPass }, { OutputPass }] = await Promise.all([
        import('three/addons/postprocessing/EffectComposer.js'),
        import('three/addons/postprocessing/RenderPass.js'),
        import('three/addons/postprocessing/UnrealBloomPass.js'),
        import('three/addons/postprocessing/OutputPass.js'),
      ]);
      this.composer = new EffectComposer(this.renderer);
      this.composer.addPass(new RenderPass(this.scene, this.camera));
      this.bloom = new UnrealBloomPass(new THREE.Vector2(w, h), this.tune.bloom, this.tune.radius, this.tune.threshold);
      this.composer.addPass(this.bloom);
      this.composer.addPass(new OutputPass());
    } catch {
      this.composer = null;
    }
  }

  // ---------- public API ----------
  setState(s) { this.state = s; }
  setAudioLevel(v = 0) { this.audioLevel = Math.max(0, Math.min(1, v)); }
  pulse(amount = 0.4) { this.energy = Math.min(1, this.energy + amount); }

  _animate() {
    this._raf = requestAnimationFrame(() => this._animate());
    if (this.paused) { this.clock.getDelta(); return; }
    const dt = Math.min(0.05, this.clock.getDelta());
    this._t = this.clock.elapsedTime;   // wall-clock: boot-up and cycles keep time even if frames are skipped
    const t = this._t;
    const ease = 1 - Math.pow(1 - 0.14, dt * 60);

    const S = this.state;
    const thinking = S === HoloState.THINKING || S === HoloState.DESIGNING;
    const building = S === HoloState.BUILDING;
    const speaking = S === HoloState.SPEAKING;
    const listening = S === HoloState.LISTENING;

    this.energy *= 0.9;
    const level = this.audioLevel;
    const react = Math.max(this.energy, level);

    // boot-up materialisation
    this.boot = Math.min(1, Math.max(0, (t - 0.3) / 2.4));
    const reveal = this.boot < 1 ? this.boot * this.boot * (3 - 2 * this.boot) : 1;
    const bootFade = Math.min(1, t / 1.6);

    // glitches: short shears every few seconds, more often while working
    if (t > this._nextGlitch) {
      this.glitch = 1;
      this._glitchEnd = t + 0.06 + Math.random() * 0.1;
      this._nextGlitch = this._glitchEnd + (thinking || building ? 1.5 : 5.0) + Math.random() * 6;
    }
    const g = t < this._glitchEnd ? (Math.random() < 0.5 ? 1 : -1) * this.glitch : 0;
    if (t >= this._glitchEnd) this.glitch = 0;

    // glint travelling along the visor line now and then (idle only)
    if (t > this._nextGlint && !speaking && !thinking && !building) {
      this._glintStart = t;
      this._nextGlint = t + 4 + Math.random() * 5;
    }
    const glintX = -1.2 + (t - this._glintStart) * 2.2;

    // gaze: float, sway, follow the cursor, slight tilt
    const bob = Math.sin(t * 0.9) * 0.035;
    this.helmet.position.y = 0.32 + bob + (1 - reveal) * -0.25;
    const sway = Math.sin(t * 0.35) * (thinking ? 0.10 : 0.04);
    const targetYaw = this.mouse.x * 0.24 + sway;
    const targetPitch = -this.mouse.y * 0.09 + Math.sin(t * 0.5) * 0.012;
    this.rig.rotation.y += (targetYaw - this.rig.rotation.y) * ease;
    this.rig.rotation.x += (targetPitch - this.rig.rotation.x) * ease;
    this.rig.rotation.z += (-this.mouse.x * 0.025 - this.rig.rotation.z) * ease;
    this.helmet.position.x = g * 0.012;

    // shell / pods
    const scanOn = thinking || building ? 1 : 0;
    const scanPos = 1.2 - ((t * (building ? 1.1 : 0.55)) % 1) * 2.6;
    const intensity = ((listening ? 0.92 + 0.08 * Math.sin(t * 2.2) : 1) + react * 0.14 + (building ? 0.08 : 0)) * bootFade * this.tune.shell;
    const gridBoost = building ? 0.22 + 0.22 * Math.sin(t * 6) : 0;
    const sheen = -2.4 + (t % 9) * 0.8;
    for (const m of this.holoMats) {
      const u = m.uniforms;
      u.uTime.value = t; u.uGlitch.value = g; u.uScan.value = scanPos; u.uReveal.value = reveal;
      u.uScanOn.value += (scanOn - u.uScanOn.value) * ease;
      u.uIntensity.value = intensity; u.uLevel.value = level; u.uGridBoost.value = gridBoost; u.uSheen.value = sheen;
    }
    for (const m of this.chromeMats) {
      m.uniforms.uTime.value = t; m.uniforms.uGlitch.value = g; m.uniforms.uReveal.value = reveal;
      m.uniforms.uIntensity.value = (this.tune.chrome + react * 0.12) * bootFade;
    }
    this.glass.material.uniforms.uTime.value = t;
    this.glass.material.uniforms.uGlitch.value = g;
    this.innerLip.material.opacity = 0.9 * reveal;
    this.outerLip.material.opacity = 0.55 * reveal;
    this.aura.material.uniforms.uIntensity.value = (0.35 + react * 0.2 + (thinking ? 0.08 : 0)) * bootFade;

    // the visor line
    const sm = this.smile.material.uniforms;
    sm.uTime.value = t; sm.uReveal.value = reveal; sm.uGlint.value = glintX;
    sm.uLevel.value += ((speaking ? Math.max(level, 0.06) : 0) - sm.uLevel.value) * Math.min(1, dt * 18);
    sm.uMode.value = speaking ? 3 : thinking || building ? 2 : listening ? 1 : 0;

    // platform / rays / particles
    const du = this.disc.material.uniforms;
    du.uTime.value = t; du.uPulse.value = (t % 3.2) / 3.2;
    du.uIntensity.value = (0.9 + react * 0.3 + (building ? 0.25 : 0)) * bootFade;
    this.band.material.uniforms.uTime.value = t;
    this.band.material.uniforms.uIntensity.value = bootFade * (building ? 1.5 : 1);
    this.ticks.rotation.y += dt * (building ? 0.9 : thinking ? 0.35 : 0.12);
    this.rays.material.opacity = (0.3 + 0.07 * Math.sin(t * 1.7) + react * 0.3 + (building ? 0.3 : 0)) * bootFade;
    this.beams.forEach((b, i) => {
      b.material.uniforms.uTime.value = t;
      b.material.uniforms.uIntensity.value = ((i ? 0.16 : 0.18) + react * 0.3 + (building ? 0.3 : thinking ? 0.08 : 0)) * bootFade;
    });
    const pm = this.particles.material.uniforms;
    pm.uTime.value = t;
    pm.uIntensity.value = (0.7 + react * 0.4 + (building ? 0.3 : 0)) * bootFade;
    const pp = this.particles.geometry.attributes.position.array;
    const speedMul = building ? 6 : thinking ? 2.2 : 1;
    for (let i = 0; i < this._pSpeed.length; i++) {
      pp[i * 3 + 1] += this._pSpeed[i] * speedMul * dt;
      if (pp[i * 3 + 1] > 2.9) pp[i * 3 + 1] = -1.9;
    }
    this.particles.geometry.attributes.position.needsUpdate = true;

    if (this.bloom) {
      this.bloom.strength = this.tune.bloom + react * 0.1 + (thinking ? 0.05 : 0) + (building ? 0.08 : 0);
      this.bloom.radius = this.tune.radius; this.bloom.threshold = this.tune.threshold;
      this.renderer.toneMappingExposure = this.tune.exposure;
    }

    if (this.composer) this.composer.render();
    else this.renderer.render(this.scene, this.camera);
  }

  resize() {
    const w = this.canvas.clientWidth, h = this.canvas.clientHeight;
    if (!w || !h) return;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h, false);
    this.composer?.setSize(w, h);
    if (this.particles) this.particles.material.uniforms.uPixelRatio.value = this.renderer.getPixelRatio();
  }

  dispose() {
    cancelAnimationFrame(this._raf);
    window.removeEventListener('pointermove', this._onMove);
    this._ro?.disconnect();
    this.renderer.dispose();
  }
}
