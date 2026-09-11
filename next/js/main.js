// main.js — liquid-glass homepage: scene state, blob physics, camera, overlays, rendering.
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { VERT, FRAG } from './shaders.js';
import { textSDF } from './sdf.js';

const q = new URLSearchParams(location.search);
const DEBUG = q.has('debug');
const FIXED_DT = q.has('fixeddt');
const FORCE_P = q.has('p') ? parseFloat(q.get('p')) : null;
const FORCE_SCALE = q.has('scale') ? parseFloat(q.get('scale')) : null;

const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
const mobile = matchMedia('(pointer: coarse)').matches || matchMedia('(max-width: 900px)').matches;

const $ = s => document.querySelector(s);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const lerp = (a, b, t) => a + (b - a) * t;
const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };

// ── Scene definition: four liquid clusters along -z ──
const GAP = 24;
const CLUSTERS = [
  { id: 'hero',    lines: ['AARON', 'KOSHY'], texW: 11.5, texH: 5.75, canvas: [1024, 512], x: 0,    y: 1.0, core: [6.6, 3.5, 0.85] },
  { id: 'about',   lines: ['ABOUT'],          texW: 9.5,  texH: 3.56, canvas: [1024, 384], x: -9,   y: 0.4, core: [5.6, 2.5, 0.85] },
  { id: 'work',    slabs: true,                                                            x: 9,    y: 0.1, core: [8.3, 1.9, 0.6], coreZ: -1.0 },
  { id: 'contact', lines: ['SAY', 'HELLO'],   texW: 10,   texH: 5,    canvas: [1024, 512], x: -9,   y: 0.2, core: [5.9, 3.2, 0.85] },
];
CLUSTERS.forEach((c, i) => { c.z = -i * GAP; c.center = new THREE.Vector3(c.x, c.y, c.z); c.coreHalf = new THREE.Vector3(...c.core); c.corePos = new THREE.Vector3(c.x, c.y, c.z + (c.coreZ || 0)); });
const SLAB_X = [-5.6, -1.85, 1.85, 5.6];
const SLAB_HALF = new THREE.Vector3(1.65, 1.03, 0.11);
const N = CLUSTERS.length;
const DW = 0.28;
const CAM_DIST = mobile ? 21 : 13.5;                      // dwell half-width around each cluster, in segment units

function makeBlobs(c) {
  const blobs = [];
  const rnd = mulberry(c.id.length * 7 + 3);
  if (c.slabs) {
    for (let i = 0; i < 9; i++) {
      const x = -7.8 + i * 1.95 + (rnd() - 0.5) * 0.8;
      const y = (i % 2 ? 1 : -1) * (1.6 + rnd() * 0.7);
      blobs.push(blob(x, y, -1.0 - rnd() * 0.6, 0.85 + rnd() * 0.5));
    }
  } else {
    const n = c.lines.length > 1 ? 11 : 9;
    for (let i = 0; i < n; i++) {
      const f = i / (n - 1);
      const x = lerp(-c.texW * 0.5, c.texW * 0.5, f) + (rnd() - 0.5) * 1.2;
      const r = c.texH * (0.20 + rnd() * 0.12);
      const y = (i % 2 ? 1 : -1) * (c.texH * 0.5 + r * 0.55 + rnd() * 0.4);
      blobs.push(blob(x, y, (rnd() - 0.5) * 0.9, r));
    }
  }
  for (let i = 0; i < 3; i++) {   // small satellite drips
    const a = rnd() * Math.PI * 2, r = 7 + rnd() * 2.5;
    blobs.push(blob(Math.cos(a) * r, Math.sin(a) * r * 0.55, (rnd() - 0.5) * 2, 0.55 + rnd() * 0.45));
  }
  for (let i = 0; i < 3; i++) {   // transit droplets: above/below the flight path, never in the sightline
    const side = (i % 2 ? 1 : -1) * (5 + rnd() * 4);
    const up = (rnd() > 0.5 ? 1 : -1) * (5 + rnd() * 2.5);
    const d = blob(side, up, -GAP * (0.3 + i * 0.18), 0.5 + rnd() * 0.5); d.drip = true; blobs.push(d);
  }
  return blobs;
  function blob(x, y, z, r) {
    const home = new THREE.Vector3(x + c.x, y + c.y, z + c.z);
    return { home, pos: home.clone(), vel: new THREE.Vector3(), r, ph: rnd() * 6.28, w: 0.35 + rnd() * 0.4 };
  }
}
function mulberry(a) { return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
CLUSTERS.forEach(c => { c.blobs = makeBlobs(c); });

// ── Pointer ──
const pointer = { x: innerWidth / 2, y: innerHeight / 2, inside: false, down: false, moved: 0, type: 'mouse' };
window.addEventListener('pointermove', e => { pointer.x = e.clientX; pointer.y = e.clientY; pointer.inside = true; pointer.moved = performance.now(); pointer.type = e.pointerType; }, { passive: true });
window.addEventListener('pointerdown', e => { pointer.x = e.clientX; pointer.y = e.clientY; pointer.down = true; pointer.inside = true; pointer.moved = performance.now(); pointer.type = e.pointerType; }, { passive: true });
window.addEventListener('pointerup', () => { pointer.down = false; }, { passive: true });
document.addEventListener('mouseleave', () => { pointer.inside = false; });

// custom cursor
const cdot = $('#cursor-dot'), cring = $('#cursor-ring');
let ringX = pointer.x, ringY = pointer.y;
function cursorTick() {
  if (!cdot) return;
  ringX = lerp(ringX, pointer.x, 0.22); ringY = lerp(ringY, pointer.y, 0.22);
  cdot.style.transform = `translate(${pointer.x}px, ${pointer.y}px) translate(-50%,-50%)`;
  cring.style.transform = `translate(${ringX}px, ${ringY}px) translate(-50%,-50%)`;
  cdot.style.opacity = cring.style.opacity = pointer.inside && pointer.type !== 'touch' ? '1' : '0';
}
document.querySelectorAll('a, button').forEach(el => {
  el.addEventListener('pointerenter', () => cring?.classList.add('hover'));
  el.addEventListener('pointerleave', () => cring?.classList.remove('hover'));
});

// ── Scroll → progress ──
const scroller = $('.scroller');
let pRaw = 0, p = 0;
function readScroll() {
  if (FORCE_P !== null) { pRaw = FORCE_P; return; }
  const max = Math.max(1, document.documentElement.scrollHeight - innerHeight);
  pRaw = clamp(scrollY / max, 0, 1);
}
window.addEventListener('scroll', readScroll, { passive: true });
document.querySelectorAll('[data-goto]').forEach(a => a.addEventListener('click', e => {
  e.preventDefault();
  const k = +a.dataset.goto;
  const max = document.documentElement.scrollHeight - innerHeight;
  scrollTo({ top: (k / (N - 1)) * max, behavior: 'smooth' });
}));

// section k spans p ∈ [k/(N-1) - 0.5/(N-1), k/(N-1) + 0.5/(N-1)] roughly; camera dwells near each centre.
function cameraFor(prog) {
  const seg = prog * (N - 1);            // 0..3, integer at each cluster
  const k = Math.min(N - 2, Math.floor(seg));
  const f = seg - k;                     // 0..1 between cluster k and k+1
  // dwell: hold at k for f<0.3, travel 0.3..0.7, hold at k+1 after
  const tr = smooth(0.28, 0.72, f);
  const a = CLUSTERS[k].center, b = CLUSTERS[k + 1].center;
  const look = new THREE.Vector3().lerpVectors(a, b, Math.min(1, tr * 1.6));   // turn toward the next cluster early
  const pos = new THREE.Vector3().lerpVectors(a, b, tr).add(new THREE.Vector3(0, 0.9, CAM_DIST));
  // swing wide toward the next cluster's side and climb, so the current liquid glides past beside/below us
  const dir = Math.sign(b.x - a.x) || 1;
  const arc = Math.sin(tr * Math.PI);
  pos.x += arc * 4.0 * dir; pos.y += arc * 3.0;
  // presence: the mass we leave melts away, the next one condenses ahead of us
  const presA = 1 - smooth(0.0, 0.62, tr), presB = smooth(0.32, 0.92, tr);
  return { pos, look, k, f, tr, near: tr < 0.5 ? k : k + 1, presA, presB };
}

// ── Renderer ──
const canvas = $('#scene');
let renderer, composer, bloom, material, uniforms;
let scale = FORCE_SCALE ?? (mobile ? 0.6 : 0.85);
const targetScale = scale;

function hasWebGL2() { try { return !!document.createElement('canvas').getContext('webgl2'); } catch { return false; } }

async function buildTextures() {
  try { await document.fonts.load('800 200px Syne'); await document.fonts.ready; } catch {}
  for (const c of CLUSTERS) {
    if (!c.lines) continue;
    const s = textSDF(c.lines, { w: c.canvas[0], h: c.canvas[1] });
    const half = new Uint16Array(s.w * s.h);
    for (let i = 0; i < half.length; i++) half[i] = THREE.DataUtils.toHalfFloat(s.data[i]);
    const tex = new THREE.DataTexture(half, s.w, s.h, THREE.RedFormat, THREE.HalfFloatType);
    tex.minFilter = tex.magFilter = THREE.LinearFilter;
    tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.flipY = true; tex.needsUpdate = true;
    c.tex = tex;
    c.texSize = new THREE.Vector2(c.texW, c.texW / s.aspect);
  }
}

function loadImage(src) {
  return new Promise(res => { const im = new Image(); im.onload = () => res(im); im.onerror = () => res(null); im.src = src; });
}
async function buildAtlas(cards) {
  const W = 1024, H = 640;
  const cv = document.createElement('canvas'); cv.width = W * 2; cv.height = H * 2;
  const ctx = cv.getContext('2d');
  ctx.fillStyle = '#0a0e17'; ctx.fillRect(0, 0, cv.width, cv.height);
  const imgs = await Promise.all(cards.map(c => loadImage(c.img)));
  imgs.forEach((im, i) => {
    const ox = (i % 2) * W, oy = Math.floor(i / 2) * H;
    if (!im) { ctx.fillStyle = '#fff'; ctx.font = '800 72px Syne'; ctx.textAlign = 'center'; ctx.fillText(cards[i].title, ox + W / 2, oy + H / 2); return; }
    const s = Math.max(W / im.naturalWidth, H / im.naturalHeight);
    const w = im.naturalWidth * s, h = im.naturalHeight * s;
    ctx.save(); ctx.beginPath(); ctx.rect(ox, oy, W, H); ctx.clip();
    ctx.drawImage(im, ox + (W - w) / 2, oy, w, h); ctx.restore();
  });
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

const cards = [...document.querySelectorAll('#work-list li')].map(li => ({
  title: li.dataset.title, img: li.dataset.img, href: li.dataset.href, blurb: li.dataset.blurb, tags: li.dataset.tags.split(','), link: li.dataset.link,
}));

async function init() {
  if (!hasWebGL2()) { document.body.classList.add('no-gl'); return; }
  renderer = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: false, powerPreference: 'high-performance' });
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  renderer.setPixelRatio(scale);
  renderer.setSize(innerWidth, innerHeight, false);

  await buildTextures();
  const atlas = await buildAtlas(cards);

  uniforms = {
    uRes: { value: new THREE.Vector2() }, uTime: { value: 0 },
    uCamPos: { value: new THREE.Vector3() }, uCamMat: { value: new THREE.Matrix3() }, uTanFov: { value: Math.tan(THREE.MathUtils.degToRad(mobile ? 34 : 26)) },
    uBlobs: { value: Array.from({ length: 36 }, () => new THREE.Vector4(0, 0, 0, 0)) }, uNB: { value: 0 },
    uCursor: { value: new THREE.Vector4(0, 0, 0, 0) },
    uCoreA: { value: new THREE.Vector3() }, uCoreAHalf: { value: new THREE.Vector3(1, 1, 1) }, uCoreAOn: { value: 0 },
    uCoreB: { value: new THREE.Vector3() }, uCoreBHalf: { value: new THREE.Vector3(1, 1, 1) }, uCoreBOn: { value: 0 },
    uTexA: { value: CLUSTERS[0].tex }, uTextAPos: { value: new THREE.Vector3() }, uTextASize: { value: new THREE.Vector2(1, 1) }, uTextAOn: { value: 0 }, uTextAFade: { value: 0 },
    uTexB: { value: CLUSTERS[1].tex }, uTextBPos: { value: new THREE.Vector3() }, uTextBSize: { value: new THREE.Vector2(1, 1) }, uTextBOn: { value: 0 }, uTextBFade: { value: 0 },
    uTextDepth: { value: 0.42 },
    uSlab: { value: SLAB_X.map(x => new THREE.Vector4(CLUSTERS[2].x + x, CLUSTERS[2].y, CLUSTERS[2].z + 0.55, 0)) }, uSlabHalf: { value: SLAB_HALF }, uSlabOn: { value: 0 }, uSlabScale: { value: 1 }, uAtlas: { value: atlas },
    uIor: { value: 1.33 }, uAbsorb: { value: new THREE.Vector3(0.10, 0.17, 0.025) }, uDisp: { value: mobile ? 0 : 0.012 },
    uSteps: { value: mobile ? 72 : 110 }, uISteps: { value: mobile ? 40 : 64 },
  };
  material = new THREE.ShaderMaterial({ vertexShader: VERT, fragmentShader: FRAG, uniforms, glslVersion: THREE.GLSL3, depthTest: false, depthWrite: false });
  const scene = new THREE.Scene();
  scene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material));
  const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

  composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, cam));
  bloom = new UnrealBloomPass(new THREE.Vector2(innerWidth, innerHeight), 0.38, 0.5, 0.9);
  composer.addPass(bloom);
  composer.addPass(new OutputPass());
  applySize();
  window.addEventListener('resize', applySize);

  readScroll();
  p = pRaw;
  requestAnimationFrame(frame);
}

function applySize() {
  renderer.setPixelRatio(scale);
  renderer.setSize(innerWidth, innerHeight, false);
  composer.setPixelRatio(scale);
  composer.setSize(innerWidth, innerHeight);
  uniforms.uRes.value.set(innerWidth * scale, innerHeight * scale);
}

// ── Physics ──
const tmp = new THREE.Vector3(), tmp2 = new THREE.Vector3();
const cursorWorld = new THREE.Vector3(); let cursorR = 0;
function stepBlobs(c, dt, t, cur, curOn) {
  const B = c.blobs;
  for (let i = 0; i < B.length; i++) {
    const b = B[i];
    // breathing home
    tmp.set(Math.sin(t * b.w + b.ph) * 0.35, Math.cos(t * b.w * 0.8 + b.ph * 1.7) * 0.3, Math.sin(t * b.w * 0.6 + b.ph) * 0.25).add(b.home);
    tmp.sub(b.pos).multiplyScalar(3.2);                 // spring
    tmp.addScaledVector(b.vel, -2.4);                    // damping
    if (curOn) {
      tmp2.subVectors(b.pos, cur);
      const d = tmp2.length(), reach = b.r + cursorR + 1.4;
      if (d < reach && d > 1e-4) tmp.addScaledVector(tmp2.normalize(), (reach - d) * 14);
    }
    for (let j = 0; j < B.length; j++) {
      if (j === i) continue;
      const o = B[j];
      tmp2.subVectors(b.pos, o.pos);
      const d = tmp2.length(), minD = (b.r + o.r) * 0.72;
      if (d < minD && d > 1e-4) tmp.addScaledVector(tmp2.normalize(), (minD - d) * 7);
    }
    b.vel.addScaledVector(tmp, dt);
    b.pos.addScaledVector(b.vel, dt);
  }
}
function burst(c, center, strength) {
  for (const b of c.blobs) {
    tmp.subVectors(b.pos, center);
    const d = tmp.length();
    if (d > 9) continue;
    b.vel.addScaledVector(tmp.normalize(), strength * (1 - d / 9) * (0.6 + Math.random() * 0.8));
    b.vel.z += (Math.random() - 0.5) * strength * 0.4;
  }
}

// ── Ray helpers ──
const camPos = new THREE.Vector3(), camLook = new THREE.Vector3(), camMat = new THREE.Matrix3();
const fwd = new THREE.Vector3(), right = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0), up2 = new THREE.Vector3();
function updateCamMat() {
  fwd.subVectors(camLook, camPos).normalize();
  right.crossVectors(fwd, up).normalize();
  up2.crossVectors(right, fwd);
  camMat.set(right.x, up2.x, -fwd.x, right.y, up2.y, -fwd.y, right.z, up2.z, -fwd.z);
}
const rd = new THREE.Vector3();
function pointerRay(out) {
  const ux = (pointer.x * 2 - innerWidth) / innerHeight, uy = -(pointer.y * 2 - innerHeight) / innerHeight;
  out.set(ux * uniforms.uTanFov.value, uy * uniforms.uTanFov.value, -1).applyMatrix3(camMat).normalize();
  return out;
}
function rayPlaneZ(z, out) {
  pointerRay(rd);
  const t = (z - camPos.z) / rd.z;
  if (t <= 0) return false;
  out.copy(camPos).addScaledVector(rd, t);
  return true;
}
function slabHit() {
  pointerRay(rd);
  let best = -1, bestT = 1e9;
  SLAB_X.forEach((x, i) => {
    const c = uniforms.uSlab.value[i];
    let tmin = -1e9, tmax = 1e9;
    for (const [o, d, cc, h] of [[camPos.x, rd.x, c.x, SLAB_HALF.x], [camPos.y, rd.y, c.y, SLAB_HALF.y], [camPos.z, rd.z, c.z, SLAB_HALF.z + 0.4]]) {
      const inv = 1 / d; let t0 = (cc - h - o) * inv, t1 = (cc + h - o) * inv;
      if (t0 > t1) [t0, t1] = [t1, t0];
      tmin = Math.max(tmin, t0); tmax = Math.min(tmax, t1);
    }
    if (tmax >= Math.max(tmin, 0) && tmin < bestT) { bestT = tmin; best = i; }
  });
  return best;
}

// ── Overlays ──
const overlays = [...document.querySelectorAll('[data-range]')].map(el => {
  const [a, b, c, d] = el.dataset.range.split(',').map(Number);
  return { el, a, b, c, d };
});
function updateOverlays(prog) {
  for (const o of overlays) {
    const v = smooth(o.a, o.b, prog) * (1 - smooth(o.c, o.d, prog));
    o.el.style.opacity = v.toFixed(3);
    o.el.style.transform = `translateY(${((1 - v) * 18).toFixed(1)}px)`;
    o.el.style.pointerEvents = v > 0.5 ? 'auto' : 'none';
    o.el.setAttribute('aria-hidden', v < 0.5);
  }
}
const workDetail = $('#work-detail');
let shownCard = -1, hoverCard = -1, activeCard = 0;
function showCard(i) {
  if (i === shownCard) return;
  shownCard = i;
  const c = cards[i];
  workDetail.classList.add('swap');
  setTimeout(() => {
    workDetail.innerHTML = `<div class="num">0${i + 1}</div><h3>${c.title}</h3><p>${c.blurb}</p>
      <div class="tags">${c.tags.map(t => `<span>${t}</span>`).join('')}</div>
      <a href="${c.href}" target="_blank" rel="noopener">${c.link}</a>
      <div class="dots">${cards.map((_, k) => `<button type="button" aria-label="${cards[k].title}" aria-selected="${k === i}" data-i="${k}"></button>`).join('')}</div>`;
    workDetail.querySelectorAll('button').forEach(b => b.addEventListener('click', () => gotoCard(+b.dataset.i)));
    workDetail.querySelectorAll('a, button').forEach(el => {
      el.addEventListener('pointerenter', () => cring?.classList.add('hover'));
      el.addEventListener('pointerleave', () => cring?.classList.remove('hover'));
    });
    workDetail.classList.remove('swap');
  }, 140);
}
function gotoCard(i) {
  const max = document.documentElement.scrollHeight - innerHeight;
  const k = 2;                                                       // work cluster index
  // inside the work dwell (f between 0.72 of seg 1..2 and 0.28 of seg 2..3), spread the 4 cards
  const pStart = (k - DW) / (N - 1), pEnd = (k + DW) / (N - 1);
  scrollTo({ top: lerp(pStart, pEnd, (i + 0.5) / cards.length) * max, behavior: 'smooth' });
}
canvas.addEventListener('click', e => {
  pointer.x = e.clientX; pointer.y = e.clientY;
  const hit = uniforms?.uSlabOn.value ? slabHit() : -1;            // works for taps too
  if (hit >= 0) { window.open(cards[hit].href, '_blank', 'noopener'); return; }
  const c = CLUSTERS[nearK];
  if (rayPlaneZ(c.z, tmp2)) burst(c, tmp2, 9);
});
window.addEventListener('keydown', e => {
  if (nearK !== 2) return;
  if (e.key === 'ArrowRight') gotoCard(Math.min(3, activeCard + 1));
  if (e.key === 'ArrowLeft') gotoCard(Math.max(0, activeCard - 1));
});

// ── Debug overlay ──
let dbgEl = null, fps = 0, fpsN = 0, fpsT = 0, frameMs = 16;
if (DEBUG) {
  dbgEl = document.createElement('pre'); dbgEl.id = 'dbg';
  document.body.appendChild(dbgEl);
  window.addEventListener('error', e => { dbgEl.dataset.err = (dbgEl.dataset.err || '') + '\n' + e.message; });
}

// ── Frame ──
let last = performance.now(), tSim = 0, nearK = 0, frames = 0;
function frame(now) {
  const realMs = now - last;
  let dt = FIXED_DT ? 1 / 60 : Math.min(realMs / 1000, 0.05);
  last = now;
  if (frames > 5) frameMs = lerp(frameMs, realMs, 0.08);      // GPU-bound cost shows up as rAF interval
  tSim += dt;
  frames++;
  const t = tSim;

  // adaptive resolution
  if (!FORCE_SCALE && frames > 30 && frames % 30 === 0) {
    if (frameMs > 24 && scale > 0.45) { scale = Math.max(0.45, scale * 0.85); applySize(); }
    else if (frameMs < 11 && scale < targetScale) { scale = Math.min(targetScale, scale * 1.1); applySize(); }
  }

  readScroll();
  p = reduce ? pRaw : lerp(p, pRaw, Math.min(1, dt * 7));
  const cam = cameraFor(p);
  nearK = cam.near;

  // work section: pan across the slabs
  {
    let w = 0;
    if (cam.near === 2) { const off = cam.k === 2 ? cam.tr : 1 - cam.tr; w = 1 - smooth(0, 0.5, off); }
    const pStart = (2 - DW) / (N - 1), pEnd = (2 + DW) / (N - 1);
    const s = clamp((p - pStart) / (pEnd - pStart), 0, 1);
    activeCard = Math.min(cards.length - 1, Math.floor(s * cards.length));
    const cx = SLAB_X[activeCard] * 0.55;
    cam.pos.x += cx * w; cam.look.x += cx * 0.9 * w;
  }
  // pointer parallax
  const px = pointer.inside ? (pointer.x / innerWidth - 0.5) : 0, py = pointer.inside ? (pointer.y / innerHeight - 0.5) : 0;
  camPos.lerp(cam.pos.add(new THREE.Vector3(px * 0.9, -py * 0.5, 0)), Math.min(1, dt * 6));
  camLook.lerp(cam.look, Math.min(1, dt * 6));
  camPos.y += Math.sin(t * 0.5) * 0.04;
  updateCamMat();

  // cursor droplet on the nearest cluster's plane
  const c = CLUSTERS[nearK];
  const fresh = pointer.inside && (pointer.type !== 'touch' || pointer.down) && now - pointer.moved < 4000;
  const curOn = fresh && rayPlaneZ(c.z + 1.2, tmp);
  cursorR = lerp(cursorR, curOn ? 0.62 : 0, Math.min(1, dt * 8));
  if (curOn) cursorWorld.lerp(tmp, Math.min(1, dt * 14));
  uniforms.uCursor.value.set(cursorWorld.x, cursorWorld.y, cursorWorld.z, cursorR > 0.02 ? cursorR : 0);

  // physics on the two clusters around the camera
  const active = [cam.k, cam.k + 1];
  if (!reduce) for (const k of active) stepBlobs(CLUSTERS[k], dt, t, cursorWorld, curOn && k === nearK);

  // upload blobs
  let n = 0;
  const pres = [cam.presA, cam.presB];
  active.forEach((k, ai) => { for (const b of CLUSTERS[k].blobs) { if (n >= 36) break; const r = b.drip ? b.r : b.r * pres[ai]; if (r > 0.02) uniforms.uBlobs.value[n++].set(b.pos.x, b.pos.y, b.pos.z, r); } });
  uniforms.uNB.value = n;

  // texts
  const [A, B] = active.map(k => CLUSTERS[k]);
  uniforms.uCoreAOn.value = cam.presA > 0.02 ? 1 : 0; uniforms.uCoreAHalf.value.copy(A.coreHalf).multiplyScalar(cam.presA);
  uniforms.uTextAFade.value = (1 - cam.presA) * 2.5; uniforms.uTextBFade.value = (1 - cam.presB) * 2.5;
  uniforms.uSlabScale.value = Math.max(0.001, active[0] === 2 ? cam.presA : cam.presB);
  uniforms.uCoreA.value.copy(A.corePos).add(tmp.set(Math.sin(t * 0.37) * 0.25, Math.cos(t * 0.29) * 0.2, 0));
  uniforms.uCoreBOn.value = cam.presB > 0.02 ? 1 : 0; uniforms.uCoreBHalf.value.copy(B.coreHalf).multiplyScalar(cam.presB);
  uniforms.uCoreB.value.copy(B.corePos).add(tmp.set(Math.cos(t * 0.33) * 0.25, Math.sin(t * 0.27) * 0.2, 0));
  uniforms.uTextAOn.value = A.tex ? 1 : 0;
  if (A.tex) { uniforms.uTexA.value = A.tex; uniforms.uTextAPos.value.copy(A.center); uniforms.uTextASize.value.copy(A.texSize); }
  uniforms.uTextBOn.value = B.tex ? 1 : 0;
  if (B.tex) { uniforms.uTexB.value = B.tex; uniforms.uTextBPos.value.copy(B.center); uniforms.uTextBSize.value.copy(B.texSize); }
  uniforms.uSlabOn.value = active.includes(2) ? 1 : 0;

  // slab hover
  hoverCard = uniforms.uSlabOn.value && pointer.inside && pointer.type !== 'touch' ? slabHit() : -1;
  uniforms.uSlab.value.forEach((v, i) => { v.w = lerp(v.w, i === hoverCard ? 1 : 0, Math.min(1, dt * 10)); v.y = CLUSTERS[2].y + Math.sin(t * 0.8 + i) * 0.12; });
  canvas.style.cursor = hoverCard >= 0 ? 'pointer' : '';
  cring?.classList.toggle('hover', hoverCard >= 0);
  if (nearK === 2) showCard(hoverCard >= 0 ? hoverCard : activeCard);

  uniforms.uTime.value = t;
  uniforms.uCamPos.value.copy(camPos);
  uniforms.uCamMat.value.copy(camMat);

  composer.render();

  updateOverlays(p);
  cursorTick();
  if (frames === 2) document.body.classList.add('ready');

  if (dbgEl) {
    fpsN++; if (now - fpsT > 500) { fps = Math.round(fpsN * 1000 / (now - fpsT)); fpsN = 0; fpsT = now; }
    dbgEl.textContent = `fps ${fps}  render ${frameMs.toFixed(1)}ms  scale ${scale.toFixed(2)}  ${innerWidth}x${innerHeight} dpr ${devicePixelRatio}\np ${p.toFixed(3)} seg k=${cam.k} f=${cam.f.toFixed(2)} tr=${cam.tr.toFixed(2)} near=${nearK}\ncam ${camPos.x.toFixed(1)},${camPos.y.toFixed(1)},${camPos.z.toFixed(1)} blobs ${n} cursorR ${cursorR.toFixed(2)} hover ${hoverCard}\nmobile=${mobile} reduce=${reduce}\nptr ${pointer.x},${pointer.y} inside=${pointer.inside} type=${pointer.type} age=${Math.round(now - pointer.moved)} fresh=${fresh} rawHit=${uniforms.uSlabOn.value ? slabHit() : 'n/a'} rd=${pointerRay(rd).toArray().map(v => v.toFixed(2)).join(',')} slab2=${uniforms.uSlab.value[2].toArray().map(v => v.toFixed(1)).join(',')}${dbgEl.dataset.err || ''}`;
  }
  requestAnimationFrame(frame);
}

init().catch(err => { console.error(err); document.body.classList.add('no-gl'); if (dbgEl) dbgEl.textContent = 'INIT FAILED ' + err.message; });
