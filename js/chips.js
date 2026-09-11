// chips.js — the skill chips in "About" become matter.js rigid bodies that tumble into
// a glass tray. The chips stay real DOM text; only their transform is driven by physics.

const MATTER_URL = 'https://cdn.jsdelivr.net/npm/matter-js@0.20.0/build/matter.min.js';

function loadScript(src) {
  return new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = src; s.async = true; s.onload = res; s.onerror = () => rej(new Error('load failed: ' + src));
    document.head.appendChild(s);
  });
}

export async function initChips(container, pointer) {
  if (!container) return;
  if (!window.Matter) await loadScript(MATTER_URL);
  const M = window.Matter;
  const chips = [...container.querySelectorAll('span')];
  if (!chips.length) return;

  container.classList.add('physics');
  const ring = document.getElementById('cursor-ring');
  const dot = document.getElementById('cursor-dot');

  const sizes = chips.map(el => ({ w: el.offsetWidth, h: el.offsetHeight }));
  chips.forEach((el, i) => {
    el.style.transform = `translate(${-sizes[i].w - 40}px, ${-sizes[i].h - 40}px)`;
    el.addEventListener('pointerenter', () => { ring?.classList.add('hover'); dot?.classList.add('hover'); });
    el.addEventListener('pointerleave', () => { ring?.classList.remove('hover'); dot?.classList.remove('hover'); });
  });

  const engine = M.Engine.create({ enableSleeping: true });
  engine.gravity.y = 1.25;
  const world = engine.world;

  let W = container.clientWidth, H = container.clientHeight, walls = [];
  function buildWalls() {
    if (walls.length) M.Composite.remove(world, walls);
    W = container.clientWidth; H = container.clientHeight;
    const T = 200, opts = { isStatic: true, friction: 0.4, restitution: 0.2 };
    walls = [
      M.Bodies.rectangle(W / 2, H + T / 2, W * 3, T, opts),          // floor
      M.Bodies.rectangle(-T / 2, H / 2 - H * 2, T, H * 6, opts),      // left
      M.Bodies.rectangle(W + T / 2, H / 2 - H * 2, T, H * 6, opts),   // right
      M.Bodies.rectangle(W / 2, -H * 4 - T / 2, W * 3, T, opts),      // ceiling, far above
    ];
    M.Composite.add(world, walls);
  }
  buildWalls();

  const bodies = chips.map((el, i) => {
    const { w, h } = sizes[i];
    const b = M.Bodies.rectangle(-500, -500, w, h, {
      chamfer: { radius: Math.max(2, Math.min(h / 2 - 1, 16)) },
      restitution: 0.42, friction: 0.35, frictionAir: 0.012, density: 0.0016,
      sleepThreshold: 45,
    });
    b.added = false;
    return b;
  });

  const mouse = M.Mouse.create(container);
  const mc = M.MouseConstraint.create(engine, { mouse, constraint: { stiffness: 0.18, damping: 0.08, angularStiffness: 0.15 } });
  M.Composite.add(world, mc);
  // Let the page keep scrolling with the wheel over the tray.
  ['wheel', 'mousewheel', 'DOMMouseScroll'].forEach(ev => { try { container.removeEventListener(ev, mouse.mousewheel); } catch {} });
  container.addEventListener('pointerleave', () => { mouse.button = -1; });

  function spawn() {
    bodies.forEach((b, i) => {
      setTimeout(() => {
        const { w, h } = sizes[i];
        const x = w / 2 + 10 + Math.random() * Math.max(10, W - w - 20);
        M.Body.setPosition(b, { x, y: -h - 24 - i * 6 });
        M.Body.setAngle(b, (Math.random() - 0.5) * 0.8);
        M.Body.setVelocity(b, { x: (Math.random() - 0.5) * 2, y: 1 });
        M.Composite.add(world, b);
        b.added = true;
        wake();
      }, 120 + i * 110);
    });
  }

  function shake() {
    bodies.forEach(b => {
      if (!b.added) return;
      M.Sleeping.set(b, false);
      M.Body.applyForce(b, b.position, { x: (Math.random() - 0.5) * 0.02 * b.mass, y: (-0.028 - Math.random() * 0.02) * b.mass });
      M.Body.setAngularVelocity(b, (Math.random() - 0.5) * 0.25);
    });
    wake();
  }
  container.addEventListener('pointerdown', e => { if (e.target === container) shake(); });

  // ── Loop: runs only while the tray is on screen ──
  let raf = 0, visible = false, lastT = 0, accum = 0;
  const STEP = 1000 / 60;
  function tick(now) {
    raf = 0;
    if (!visible) return;
    const delta = Math.min(now - (lastT || now), 50);
    lastT = now;
    accum += delta;
    let n = 0;
    while (accum >= STEP && n < 3) { M.Engine.update(engine, STEP); accum -= STEP; n++; }
    if (n) {
      for (let i = 0; i < bodies.length; i++) {
        const b = bodies[i];
        if (!b.added) continue;
        const { w, h } = sizes[i];
        chips[i].style.transform = `translate(${(b.position.x - w / 2).toFixed(1)}px, ${(b.position.y - h / 2).toFixed(1)}px) rotate(${b.angle.toFixed(3)}rad)`;
      }
    }
    raf = requestAnimationFrame(tick);
  }
  function wake() { if (visible && !raf) { lastT = 0; raf = requestAnimationFrame(tick); } }

  let spawned = false;
  const io = new IntersectionObserver(es => es.forEach(e => {
    visible = e.isIntersecting;
    if (visible && !spawned) { spawned = true; spawn(); }
    if (visible) wake();
  }), { threshold: 0.2 });
  io.observe(container);

  let rt = 0;
  window.addEventListener('resize', () => {
    clearTimeout(rt);
    rt = setTimeout(() => {
      buildWalls();
      bodies.forEach((b, i) => {
        if (!b.added) return;
        const { w } = sizes[i];
        const x = Math.min(Math.max(b.position.x, w / 2 + 4), W - w / 2 - 4);
        M.Body.setPosition(b, { x, y: Math.min(b.position.y, H - sizes[i].h / 2 - 2) });
        M.Sleeping.set(b, false);
      });
      wake();
    }, 200);
  });
}
