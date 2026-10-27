// tune.js — the /next/ live settings panel (lil-gui). Loaded on demand by main.js on /next/
// only. Every control writes straight into a live shader uniform, a render/bloom setting or
// the scene's P object, so changes show on the next frame. Values persist per browser in
// localStorage; "Copy settings" exports only what differs from the built-in defaults, for
// baking into the code as new defaults.

// By path, not through the import map: nginx pins the import map's hash in the CSP, so
// adding an entry there blocks the whole page.
import { GUI } from '../vendor/lil-gui/lil-gui.esm.min.js';

const STORE_KEY = 'ak-next-tune';
const store = {
  get() { try { return JSON.parse(localStorage.getItem(STORE_KEY) || 'null'); } catch { return null; } },
  set(v) { try { localStorage.setItem(STORE_KEY, JSON.stringify(v)); } catch {} },
  clear() { try { localStorage.removeItem(STORE_KEY); } catch {} },
};

export function initTune(ctx) {
  const { THREE, uniforms: U, renderer, bloom, taa, plainPass, P } = ctx;
  const gui = new GUI({ title: 'Scene settings' });
  gui.domElement.classList.add('ak-tune');
  gui.close();

  // ── registry: one entry per control, so save / load / reset / export work off real values
  // (lil-gui's own save() rounds colours to 8-bit hex) ──
  const reg = new Map();
  let saveTimer = 0;
  const persist = () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => store.set({ v: 1, values: snapshot() }), 250);
  };
  const snapshot = () => Object.fromEntries([...reg].map(([k, r]) => [k, r.get()]));
  const refresh = () => gui.controllersRecursive().forEach(c => c.updateDisplay());

  // A number control bound through getter/setter, so the panel reads and writes the live value.
  function num(folder, key, label, get, set, min, max, step, { heavy = false } = {}) {
    const holder = heavy ? { v: get() } : { get v() { return get(); }, set v(x) { set(x); } };
    const c = folder.add(holder, 'v', min, max, step).name(label);
    if (heavy) c.onFinishChange(v => { set(v); persist(); });   // e.g. resolution: realloc once on release
    else c.onChange(persist);
    reg.set(key, { get, set: v => { set(v); if (heavy) holder.v = v; }, def: get() });
    return c;
  }
  function bool(folder, key, label, get, set) {
    const holder = { get v() { return get(); }, set v(x) { set(x); } };
    folder.add(holder, 'v').name(label).onChange(persist);
    reg.set(key, { get, set, def: get() });
  }
  // A colour bound to a THREE.Vector3 (the shader's raw linear values); onSet runs after writes.
  function color(folder, key, label, vec, onSet = () => {}) {
    const proxy = {
      get r() { return vec.x; }, set r(a) { vec.x = a; onSet(); },
      get g() { return vec.y; }, set g(a) { vec.y = a; onSet(); },
      get b() { return vec.z; }, set b(a) { vec.z = a; onSet(); },
    };
    folder.addColor({ c: proxy }, 'c').name(label).onChange(persist);
    reg.set(key, { get: () => [vec.x, vec.y, vec.z], set: a => { vec.set(a[0], a[1], a[2]); onSet(); }, def: [vec.x, vec.y, vec.z] });
  }
  function choice(folder, key, label, options, get, set) {
    const holder = { get v() { return get(); }, set v(x) { set(x); } };
    folder.add(holder, 'v', options).name(label).onChange(persist);
    reg.set(key, { get, set, def: get() });
  }
  const uni = (folder, name, label, min, max, step, opts) =>
    num(folder, name, label, () => U[name].value, v => { U[name].value = v; }, min, max, step, opts);
  const comp = (folder, name, axis, label, min, max, step) =>
    num(folder, `${name}.${axis}`, label, () => U[name].value[axis], v => { U[name].value[axis] = v; }, min, max, step);
  const param = (folder, key, label, min, max, step, after = () => {}) =>
    num(folder, `P.${key}`, label, () => P[key], v => { P[key] = v; after(); }, min, max, step);

  // Glass glow is stored as colour x strength so the colour picker shows a readable colour.
  const GLOW_K0 = 0.35;
  const glowBase = U.uGlowColor.value.clone().divideScalar(GLOW_K0);
  let glowK = GLOW_K0;
  const applyGlow = () => U.uGlowColor.value.copy(glowBase).multiplyScalar(glowK);

  // ── Colours ──
  const fCol = gui.addFolder('Colours');
  color(fCol, 'uTextColor', 'Text', U.uTextColor.value);
  color(fCol, 'uSkyLow', 'Sky (low)', U.uSkyLow.value);
  color(fCol, 'uSkyHigh', 'Sky (high)', U.uSkyHigh.value);
  color(fCol, 'uFloorGlow', 'Floor glow', U.uFloorGlow.value);
  color(fCol, 'uHorizonColor', 'Horizon', U.uHorizonColor.value);
  color(fCol, 'glowColor', 'Glass glow', glowBase, applyGlow);
  color(fCol, 'uTIRColor', 'Glass edge tint (TIR)', U.uTIRColor.value);
  color(fCol, 'uSb0Color', 'Softbox 1', U.uSb0Color.value);
  color(fCol, 'uSb1Color', 'Softbox 2', U.uSb1Color.value);
  color(fCol, 'uSb2Color', 'Softbox 3', U.uSb2Color.value);

  // ── Lighting ──
  const fLight = gui.addFolder('Lighting');
  uni(fLight, 'uSb0I', 'Softbox 1 intensity', 0, 8, 0.05);
  uni(fLight, 'uSb1I', 'Softbox 2 intensity', 0, 8, 0.05);
  uni(fLight, 'uSb2I', 'Softbox 3 intensity', 0, 8, 0.05);
  uni(fLight, 'uBgScale', 'Background brightness', 0, 2, 0.01);
  uni(fLight, 'uVignette', 'Vignette', 0, 1, 0.01);
  num(fLight, 'exposure', 'Exposure', () => renderer.toneMappingExposure, v => { renderer.toneMappingExposure = v; }, 0.2, 3, 0.01);
  num(fLight, 'glowStrength', 'Glass glow strength', () => glowK, v => { glowK = v; applyGlow(); }, 0, 1.5, 0.01);

  // ── Glass ──
  const fGlass = gui.addFolder('Glass');
  uni(fGlass, 'uIor', 'Refraction (IOR)', 1, 2, 0.005);
  uni(fGlass, 'uDisp', 'Dispersion', 0, 0.06, 0.001);
  comp(fGlass, 'uAbsorb', 'x', 'Absorption red', 0, 0.6, 0.005);
  comp(fGlass, 'uAbsorb', 'y', 'Absorption green', 0, 0.6, 0.005);
  comp(fGlass, 'uAbsorb', 'z', 'Absorption blue', 0, 0.6, 0.005);
  uni(fGlass, 'uHaloMin', 'Letter halo (1 = none)', 0, 1, 0.01);
  uni(fGlass, 'uHaloRange', 'Letter halo width', 0.05, 3, 0.01);

  // ── Liquid shape ──
  const fShape = gui.addFolder('Liquid shape');
  uni(fShape, 'uCoreRound', 'Block corner roundness', 0.05, 1.5, 0.01);
  uni(fShape, 'uCoreBlend', 'Block-to-block blend', 0.1, 3, 0.01);
  uni(fShape, 'uBlobBlend', 'Blob blend', 0.1, 3, 0.01);
  uni(fShape, 'uCursorBlend', 'Cursor blend', 0.1, 3, 0.01);

  // ── Text ──
  const fText = gui.addFolder('Text');
  const T = ctx.TEXT, restyle = ctx.rebuildText;
  choice(fText, 'text.font', 'Font', ctx.FONT_LIST, () => T.font, v => { T.font = v; restyle(); });
  num(fText, 'text.weight', 'Weight', () => T.weight, v => { T.weight = v; restyle(); }, 100, 900, 100, { heavy: true });
  bool(fText, 'text.italic', 'Italic', () => T.italic, v => { T.italic = v; restyle(); });
  num(fText, 'text.spacing', 'Letter spacing', () => T.spacing, v => { T.spacing = v; restyle(); }, -0.15, 0.4, 0.005, { heavy: true });
  num(fText, 'text.lineHeight', 'Line spacing', () => T.lineHeight, v => { T.lineHeight = v; restyle(); }, 0.6, 1.5, 0.01, { heavy: true });
  num(fText, 'text.fill', 'Fill of text box', () => T.fill, v => { T.fill = v; restyle(); }, 0.4, 1, 0.01, { heavy: true });
  param(fText, 'textScale', 'Letter size', 0.3, 2, 0.01);
  uni(fText, 'uTextDepth', 'Extrusion depth', 0.02, 1.5, 0.01);
  uni(fText, 'uTextRound', 'Extrusion edge rounding', 0, 0.2, 0.001);
  param(fText, 'textZ', 'Position in glass (front/back)', -1.5, 1.5, 0.01);
  bool(fText, 'uBorderOn', '3D border', () => U.uBorderOn.value > 0.5, v => { U.uBorderOn.value = v ? 1 : 0; });
  color(fText, 'uBorderColor', 'Border colour', U.uBorderColor.value);
  uni(fText, 'uBorderWidth', 'Border width', 0, 0.5, 0.005);
  uni(fText, 'uBorderSoft', 'Border edge softness', 0, 0.2, 0.005);
  uni(fText, 'uBorderSides', 'Colour the sides', 0, 1, 0.01);
  uni(fText, 'uBorderBevel', 'Bevel', 0, 3, 0.01);
  uni(fText, 'uBorderBright', 'Border brightness', 0, 3, 0.01);

  // ── Bloom ──
  const fBloom = gui.addFolder('Bloom');
  bool(fBloom, 'bloom.enabled', 'Enabled', () => bloom.enabled, v => { bloom.enabled = v; });
  num(fBloom, 'bloom.strength', 'Strength', () => bloom.strength, v => { bloom.strength = v; }, 0, 3, 0.01);
  num(fBloom, 'bloom.radius', 'Radius', () => bloom.radius, v => { bloom.radius = v; }, 0, 1, 0.01);
  num(fBloom, 'bloom.threshold', 'Threshold', () => bloom.threshold, v => { bloom.threshold = v; }, 0, 3, 0.01);

  // ── Motion ──
  const fMotion = gui.addFolder('Motion');
  param(fMotion, 'speed', 'Simulation speed', 0, 3, 0.01);
  param(fMotion, 'spring', 'Spring (pull home)', 0, 12, 0.05);
  param(fMotion, 'damping', 'Damping', 0, 8, 0.05);
  param(fMotion, 'breathe', 'Breathing amount', 0, 3, 0.01);
  param(fMotion, 'separation', 'Blob separation force', 0, 20, 0.1);
  param(fMotion, 'blobGap', 'Blob spacing', 0.3, 1.5, 0.01);
  param(fMotion, 'cursorPush', 'Cursor push', 0, 40, 0.5);
  param(fMotion, 'cursorReach', 'Cursor reach', 0, 4, 0.05);
  param(fMotion, 'cursorRadius', 'Cursor droplet size', 0, 1.5, 0.01);
  param(fMotion, 'cursorFollow', 'Cursor follow speed', 1, 30, 0.5);
  param(fMotion, 'burst', 'Click burst', 0, 30, 0.5);

  // ── Scrolling ──
  const fScroll = gui.addFolder('Scrolling');
  param(fScroll, 'scrollLength', 'Scroll length (vh)', 200, 1200, 10, ctx.applyScroll);
  param(fScroll, 'scrollSmooth', 'Scroll smoothing', 1, 30, 0.5);
  param(fScroll, 'dwellStart', 'Hold before travel', 0, 0.5, 0.01);
  param(fScroll, 'dwellEnd', 'Arrive after', 0.5, 1, 0.01);
  param(fScroll, 'workDwell', 'Work section length', 0.1, 0.45, 0.01);

  // ── Camera ──
  const fCam = gui.addFolder('Camera');
  param(fCam, 'fov', 'Field of view (deg)', 10, 70, 0.5, ctx.markFraming);
  param(fCam, 'camDist', 'Distance', 5, 40, 0.1, ctx.markFraming);
  param(fCam, 'maxPullBack', 'Max pull-back (x distance)', 1, 4, 0.05, ctx.markFraming);
  param(fCam, 'camHeight', 'Height', -3, 5, 0.05);
  param(fCam, 'swingX', 'Fly-by swing sideways', 0, 12, 0.1);
  param(fCam, 'swingY', 'Fly-by swing up', 0, 10, 0.1);
  param(fCam, 'lookAhead', 'Look-ahead', 0.5, 4, 0.05);
  param(fCam, 'fadeOut', 'Leaving cluster fades by', 0.1, 1, 0.01);
  param(fCam, 'fadeInStart', 'Next cluster fades in from', 0, 1, 0.01);
  param(fCam, 'fadeInEnd', 'Next cluster solid by', 0, 1, 0.01);
  param(fCam, 'workPan', 'Work panel pan', 0, 1.5, 0.01);
  param(fCam, 'parallaxX', 'Mouse parallax X', 0, 3, 0.05);
  param(fCam, 'parallaxY', 'Mouse parallax Y', 0, 3, 0.05);
  param(fCam, 'camFollow', 'Camera follow speed', 1, 30, 0.5);
  param(fCam, 'bob', 'Idle bob', 0, 0.3, 0.005);

  // ── Raymarch ── (step counts stop having an effect above the full shader's compile-time bounds)
  const fRay = gui.addFolder('Raymarch');
  uni(fRay, 'uSteps', 'Outer steps (max 256)', 8, 256, 1);
  uni(fRay, 'uISteps', 'Inner steps (max 128)', 8, 128, 1);
  uni(fRay, 'uStepK', 'Outer step factor', 0.3, 1, 0.01);
  uni(fRay, 'uHitEps', 'Outer hit tolerance', 0, 0.01, 0.0001);
  uni(fRay, 'uHitEpsK', 'Outer tolerance per distance', 0, 0.01, 0.0001);
  uni(fRay, 'uIStepK', 'Inner step factor', 0.3, 1, 0.01);
  uni(fRay, 'uIMinStep', 'Inner min step', 0.001, 0.1, 0.001);
  uni(fRay, 'uExitEps', 'Inner surface tolerance', 0.0002, 0.02, 0.0001);
  uni(fRay, 'uIMaxT', 'Inner max distance', 5, 80, 0.5);
  uni(fRay, 'uAABand', 'Letter edge AA width (px)', 0, 4, 0.05);

  // ── Render ──
  const fRender = gui.addFolder('Render');
  num(fRender, 'scale', 'Resolution (x CSS px)', ctx.getScale, ctx.setScale, 0.25, Math.max(ctx.dpr, 1), 0.05, { heavy: true });
  if (taa) {
    bool(fRender, 'taa.enabled', 'TAA (temporal AA)', () => taa.enabled, v => {
      taa.enabled = v; plainPass.enabled = !v;
      U.uAAPx.value = v ? taa.ratio : 1;
      if (v) taa.invalidate();
      ctx.setScale(ctx.getScale());                // refresh uRes for the pass now running
    });
    num(fRender, 'taa.feedback', 'TAA history weight', () => taa.material.uniforms.uFeedback.value, v => { taa.material.uniforms.uFeedback.value = v; }, 0, 0.98, 0.01);
  }
  let stats = false;
  bool(fRender, 'stats', 'Show stats', () => stats, v => { stats = v; ctx.setStats(v); });

  // ── Actions ──
  const status = { text: '' };
  const actions = {
    copy: () => {
      const changed = {};
      for (const [k, r] of reg) if (JSON.stringify(round(r.get())) !== JSON.stringify(round(r.def))) changed[k] = round(r.get());
      const json = JSON.stringify(changed, null, 2);
      const n = Object.keys(changed).length;
      const done = ok => { status.text = ok ? `Copied ${n} change${n === 1 ? '' : 's'}` : 'Copy failed: see console'; statusCtl.updateDisplay(); };
      if (!navigator.clipboard) { console.log(json); done(false); return; }
      navigator.clipboard.writeText(json).then(() => done(true), () => { console.log(json); done(false); });
    },
    reset: () => {
      for (const r of reg.values()) r.set(r.def);
      store.clear(); refresh();
      status.text = 'Reset to defaults'; statusCtl.updateDisplay();
    },
  };
  gui.add(actions, 'copy').name('Copy settings (JSON)');
  gui.add(actions, 'reset').name('Reset all to defaults');
  const statusCtl = gui.add(status, 'text').name('Status').disable();

  // Folders start collapsed except Colours, so the open panel stays short.
  gui.folders.forEach(f => { if (f !== fCol) f.close(); });

  // ── Restore saved values (after defaults were captured above) ──
  const saved = store.get();
  if (saved?.values) {
    for (const [k, v] of Object.entries(saved.values)) { const r = reg.get(k); if (r) try { r.set(v); } catch {} }
    refresh();
  }

  // ── Keep panel interaction from driving the page: no liquid bursts, page scroll or work
  // card paging while dragging/typing, and a real cursor (the page hides it) ──
  const el = gui.domElement;
  for (const ev of ['pointerdown', 'pointermove', 'wheel', 'touchmove', 'keydown', 'click']) el.addEventListener(ev, e => e.stopPropagation());
  el.addEventListener('pointerenter', () => document.body.classList.add('tuning'));
  el.addEventListener('pointerleave', () => document.body.classList.remove('tuning'));

  return gui;
}

function round(v) {
  const r = x => (typeof x === 'number' ? +x.toFixed(5) : x);
  return Array.isArray(v) ? v.map(r) : r(v);
}
