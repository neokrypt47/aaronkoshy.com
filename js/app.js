// app.js — orchestrator: capability gate, shared three.js renderer, one RAF loop.
// Nothing here imports a library statically, so reduced-motion users download nothing extra.

const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
const coarse = matchMedia('(pointer: coarse)').matches;
const narrow = matchMedia('(max-width: 900px)').matches;
const mobile = coarse || narrow;

function hasWebGL2() {
  try {
    const c = document.createElement('canvas');
    return !!c.getContext('webgl2');
  } catch { return false; }
}

export const caps = { reduce, mobile, webgl2: false, dpr: 1 };

// Shared pointer state. Consumers keep their own "last seen" position.
export const pointer = {
  x: innerWidth / 2, y: innerHeight / 2,
  inside: false, down: false, type: 'mouse', seq: 0,
};

function bindPointer() {
  window.addEventListener('pointermove', e => {
    pointer.x = e.clientX; pointer.y = e.clientY;
    pointer.inside = true; pointer.type = e.pointerType; pointer.seq++;
  }, { passive: true });
  window.addEventListener('pointerdown', e => {
    pointer.x = e.clientX; pointer.y = e.clientY;
    pointer.down = true; pointer.inside = true; pointer.type = e.pointerType; pointer.seq++;
  }, { passive: true });
  window.addEventListener('pointerup', () => { pointer.down = false; }, { passive: true });
  window.addEventListener('pointercancel', () => { pointer.down = false; }, { passive: true });
  document.addEventListener('mouseleave', () => { pointer.inside = false; });
  document.addEventListener('mouseenter', () => { pointer.inside = true; });
}

const warn = (what) => (err) => console.warn(`[ak] ${what} disabled:`, err);

// ── Shared renderer + views ──
let THREE = null, renderer = null, fluid = null, glOn = false;
const views = [];

function addView(view) {
  // view: { el, scene, camera, update(dt, t, rect), onResize?(widthChanged) }
  view.visible = true;
  const io = new IntersectionObserver(es => es.forEach(e => { view.visible = e.isIntersecting; }), { rootMargin: '120px' });
  io.observe(view.el);
  views.push(view);
}

function fitCamera(camera, rect, camZ) {
  camera.aspect = rect.width / rect.height;
  camera.fov = 2 * Math.atan((rect.height / 2) / camZ) * 180 / Math.PI;
  camera.position.z = camZ;
  camera.updateProjectionMatrix();
}

let lastW = innerWidth, lastH = innerHeight, resizeTimer = 0;
function onResize() {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    const widthChanged = innerWidth !== lastW;
    lastW = innerWidth; lastH = innerHeight;
    if (renderer) renderer.setSize(innerWidth, innerHeight, false);
    fluid?.resize();
    views.forEach(v => v.onResize?.(widthChanged));
  }, 150);
}

let running = true, last = performance.now();
function frame(now) {
  if (!running) return;
  const dt = Math.min((now - last) / 1000, 0.05);
  last = now;
  const t = now / 1000;

  if (fluid) fluid.step(dt, t);

  if (renderer) {
    renderer.setScissorTest(false);
    renderer.clear();
    renderer.setScissorTest(true);
    let drew = false;
    for (const v of views) {
      if (!v.visible) continue;
      const r = v.el.getBoundingClientRect();
      if (r.width < 2 || r.height < 2 || r.bottom <= 0 || r.top >= innerHeight) continue;
      fitCamera(v.camera, r, v.camZ);
      v.update(dt, t, r);
      const bottom = innerHeight - r.bottom;
      renderer.setViewport(r.left, bottom, r.width, r.height);
      renderer.setScissor(r.left, bottom, r.width, r.height);
      renderer.render(v.scene, v.camera);
      drew = true;
    }
    if (drew && !glOn) { glOn = true; renderer.domElement.classList.add('on'); }
  }
  requestAnimationFrame(frame);
}

async function main() {
  if (reduce) return;
  caps.webgl2 = hasWebGL2();
  caps.dpr = Math.min(devicePixelRatio || 1, 1.5);
  bindPointer();
  window.addEventListener('resize', onResize);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { running = false; }
    else if (!running) { running = true; last = performance.now(); requestAnimationFrame(frame); }
  });

  // Skill chips are DOM + 2D physics: independent of WebGL.
  import('./chips.js')
    .then(m => m.initChips(document.querySelector('.chips'), pointer))
    .catch(warn('chips'));

  if (!caps.webgl2) return;

  import('./fluid.js').then(m => {
    fluid = m.createFluid(document.getElementById('fluid'), { pointer, mobile });
    if (fluid) document.body.classList.add('fluid-active');
  }).catch(warn('fluid'));

  try {
    THREE = await import('three');
    renderer = new THREE.WebGLRenderer({
      canvas: document.getElementById('gl'), alpha: true, antialias: true,
      powerPreference: 'high-performance', premultipliedAlpha: true,
    });
    renderer.setPixelRatio(caps.dpr);
    renderer.setSize(innerWidth, innerHeight, false);
    renderer.setClearColor(0x000000, 0);
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.05;
  } catch (err) { warn('three')(err); return; }

  const ctx = { THREE, renderer, pointer, caps, addView };
  import('./hero.js').then(m => m.initHero(ctx)).catch(warn('hero'));
  if (!mobile) import('./deck.js').then(m => m.initDeck(ctx)).catch(warn('deck'));

  requestAnimationFrame(frame);
}

main();
