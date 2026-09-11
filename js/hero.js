// hero.js — the name as physical glass slabs: three.js rendering, Rapier rigid bodies.
// Letters drop from above, collide, then a critically-damped spring holds them in the exact
// position the DOM <h1> occupies. Cursor is a kinematic sphere; click/tap flings.

const S = 0.01;            // world px → physics metres
const CAM_Z = 1600;
const G_ROW = [0x0001, 0x0002];
const G_GROUND = [0x0004, 0x0008];
const G_CURSOR = 0x0010;
const cg = (mem, filt) => ((mem << 16) | filt) >>> 0;

export async function initHero({ THREE, renderer, pointer, caps, addView }) {
  const section = document.querySelector('.hero');
  const h1 = section?.querySelector('.hero-name');
  const chars = h1 ? [...h1.querySelectorAll('.ch')] : [];
  if (!chars.length) return;

  const [{ RoundedBoxGeometry }, { RoomEnvironment }, R] = await Promise.all([
    import('three/addons/geometries/RoundedBoxGeometry.js'),
    import('three/addons/environments/RoomEnvironment.js'),
    import('@dimforge/rapier3d-compat'),
  ]);
  await R.init();
  try { await document.fonts.load('800 100px Syne'); await document.fonts.ready; } catch {}

  const lite = caps.mobile;

  // ── Scene ──
  const scene = new THREE.Scene();
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environmentIntensity = lite ? 0.9 : 0.75;
  pmrem.dispose();

  const camera = new THREE.PerspectiveCamera(30, 1, 10, 6000);
  camera.position.set(0, 0, CAM_Z);

  scene.add(new THREE.HemisphereLight(0xffffff, 0x2b0a5e, 0.55));
  const l1 = new THREE.PointLight(0x4f8cff, lite ? 1.4 : 1.8, 0, 0);
  const l2 = new THREE.PointLight(0xd45cff, lite ? 1.2 : 1.6, 0, 0);
  scene.add(l1, l2);

  const glassMat = lite
    ? new THREE.MeshStandardMaterial({ color: 0xd9ccff, roughness: 0.22, metalness: 0.15, transparent: true, opacity: 0.6, envMapIntensity: 1.0 })
    : new THREE.MeshPhysicalMaterial({
        color: 0xd9ccff, roughness: 0.14, metalness: 0.05, transparent: true, opacity: 0.48,
        clearcoat: 1, clearcoatRoughness: 0.08, envMapIntensity: 1.1,
        emissive: 0x2a0a55, emissiveIntensity: 0.25, sheen: 0.4, sheenColor: 0xb090ff,
      });

  function glyphTexture(ch, aspect) {
    const H = 384, W = Math.max(96, Math.round(H * aspect));
    const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
    const ctx = cv.getContext('2d');
    ctx.clearRect(0, 0, W, H);
    let fs = H * 1.05;
    ctx.font = `800 ${fs}px Syne, sans-serif`;
    let m = ctx.measureText(ch);
    const gw = m.actualBoundingBoxLeft + m.actualBoundingBoxRight;
    const gh = m.actualBoundingBoxAscent + m.actualBoundingBoxDescent;
    const scale = Math.min((W * 0.86) / gw, (H * 0.86) / gh, 1);
    if (scale < 1) { fs *= scale; ctx.font = `800 ${fs}px Syne, sans-serif`; m = ctx.measureText(ch); }
    const x = W / 2 - (m.actualBoundingBoxRight - m.actualBoundingBoxLeft) / 2;
    const y = H / 2 + (m.actualBoundingBoxAscent - m.actualBoundingBoxDescent) / 2;
    ctx.fillStyle = '#ffffff';
    ctx.fillText(ch, x, y);
    const tex = new THREE.CanvasTexture(cv);
    tex.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  }

  // ── Physics ──
  let world = null, letters = [], grounds = [], cursorBody = null;
  let phase = 'idle', t0 = 0, acc = 0, seen = false;
  const tmpQ = new THREE.Quaternion(), tmpQ2 = new THREE.Quaternion(), tmpV = new THREE.Vector3();

  function clear() {
    for (const L of letters) { scene.remove(L.mesh); L.mesh.geometry.dispose(); L.glyph.material.map.dispose(); L.glyph.material.dispose(); L.glyph.geometry.dispose(); }
    letters = []; grounds = []; cursorBody = null;
    if (world) { world.free(); world = null; }
  }

  function build(now) {
    clear();
    world = new R.World({ x: 0, y: -16, z: 0 });
    world.timestep = 1 / 60;
    const sr = section.getBoundingClientRect();
    const lines = [...h1.querySelectorAll('.line')];
    const rowBase = [Infinity, Infinity];

    chars.forEach((el, i) => {
      const r = el.getBoundingClientRect();
      if (r.width < 2) return;
      const row = Math.max(0, lines.indexOf(el.closest('.line')));
      const w = r.width * 0.9, h = r.height * 0.64, d = Math.max(22, h * 0.3);
      const cx = (r.left + r.width / 2 - sr.left) - sr.width / 2;
      const cy = sr.height / 2 - (r.top + r.height / 2 - sr.top) + r.height * 0.02;
      rowBase[row] = Math.min(rowBase[row], cy - h / 2);

      const geo = new RoundedBoxGeometry(w, h, d, 3, Math.min(w, h) * 0.16);
      const mesh = new THREE.Mesh(geo, glassMat);
      const glyph = new THREE.Mesh(
        new THREE.PlaneGeometry(w * 0.92, h * 0.92),
        new THREE.MeshBasicMaterial({ map: glyphTexture(el.textContent, w / h), transparent: true, depthWrite: false, toneMapped: false })
      );
      glyph.position.z = d / 2 + 0.6;
      mesh.add(glyph);
      mesh.position.set(cx, cy + 900, 0);
      scene.add(mesh);

      const spawnX = cx + (Math.random() - 0.5) * 30;
      const spawnY = cy + 520 + Math.random() * 420 + row * 120;
      tmpQ.setFromEuler(new THREE.Euler((Math.random() - 0.5) * 0.5, (Math.random() - 0.5) * 0.7, (Math.random() - 0.5) * 0.5));
      const body = world.createRigidBody(
        R.RigidBodyDesc.dynamic()
          .setTranslation(spawnX * S, spawnY * S, 0)
          .setRotation({ x: tmpQ.x, y: tmpQ.y, z: tmpQ.z, w: tmpQ.w })
          .setLinearDamping(0.25).setAngularDamping(0.8)
          .setCcdEnabled(true).setCanSleep(false).setEnabled(false)
      );
      const col = world.createCollider(
        R.ColliderDesc.cuboid(w * S / 2, h * S / 2, d * S / 2)
          .setRestitution(0.35).setFriction(0.5).setDensity(1)
          .setCollisionGroups(cg(G_ROW[row], G_ROW[row] | G_GROUND[row] | G_CURSOR)),
        body
      );
      letters.push({ mesh, glyph, body, col, row, home: { x: cx * S, y: cy * S }, spawnAt: now + 0.35 + i * 0.075 + row * 0.15, on: false, m: body.mass(), ghost: false, stuckT: 0 });
    });

    rowBase.forEach((base, row) => {
      if (!isFinite(base)) return;
      const gb = world.createRigidBody(R.RigidBodyDesc.fixed().setTranslation(0, (base - 3) * S - 0.1, 0));
      world.createCollider(R.ColliderDesc.cuboid(sr.width * S, 0.1, 3).setFriction(0.6).setCollisionGroups(cg(G_GROUND[row], G_ROW[row])), gb);
      grounds.push(gb);
    });

    cursorBody = world.createRigidBody(R.RigidBodyDesc.kinematicPositionBased().setTranslation(0, 80, 0));
    world.createCollider(R.ColliderDesc.ball(0.72).setCollisionGroups(cg(G_CURSOR, G_ROW[0] | G_ROW[1])), cursorBody);

    phase = 'drop'; t0 = now; acc = 0;
  }

  // Solid letters collide with everything; "ghost" letters only feel the cursor so they can
  // glide home through their neighbours instead of jamming against them.
  function setGhost(L, ghost) {
    L.ghost = ghost;
    L.col.setCollisionGroups(ghost
      ? cg(G_ROW[L.row], G_CURSOR)
      : cg(G_ROW[L.row], G_ROW[0] | G_ROW[1] | G_GROUND[L.row] | G_CURSOR));
  }
  function distHome(L) {
    const p = L.body.translation();
    return Math.hypot(p.x - L.home.x, p.y - L.home.y, p.z);
  }
  let settling = false;
  function enterHold() {
    phase = 'hold'; settling = true;
    world.gravity = { x: 0, y: 0, z: 0 };
    for (const L of letters) {
      setGhost(L, true);
      L.body.setLinearDamping(0.9); L.body.setAngularDamping(1.6);
    }
  }
  function watchJams(dt) {
    if (settling) {
      if (letters.every(L => distHome(L) < 0.12)) { settling = false; letters.forEach(L => setGhost(L, false)); }
      return;
    }
    for (const L of letters) {
      const d = distHome(L);
      if (L.ghost) { if (d < 0.06) setGhost(L, false); continue; }
      L.stuckT = d > 0.3 ? L.stuckT + dt : 0;
      if (L.stuckT > 1.4) { L.stuckT = 0; setGhost(L, true); }
    }
  }

  function springs() {
    const w0 = 7.5, zeta = 0.95;
    for (const L of letters) {
      const b = L.body;
      if (!L.on) continue;
      const m = L.m, k = m * w0 * w0, c = 2 * m * w0 * zeta;
      const p = b.translation(), v = b.linvel();
      b.resetForces(false);
      b.addForce({ x: k * (L.home.x - p.x) - c * v.x, y: k * (L.home.y - p.y) - c * v.y, z: k * (0 - p.z) - c * v.z }, false);

      const q = b.rotation();
      tmpQ.set(q.x, q.y, q.z, q.w);
      tmpQ2.copy(tmpQ).invert();               // home is identity: err = home * inv(cur) = inv(cur)
      if (tmpQ2.w < 0) tmpQ2.set(-tmpQ2.x, -tmpQ2.y, -tmpQ2.z, -tmpQ2.w);
      const ang = 2 * Math.acos(Math.min(1, tmpQ2.w));
      const s = Math.sqrt(Math.max(1e-9, 1 - tmpQ2.w * tmpQ2.w));
      tmpV.set(tmpQ2.x / s, tmpQ2.y / s, tmpQ2.z / s).multiplyScalar(ang);
      const I = b.principalInertia?.();
      const Ia = I ? (I.x + I.y + I.z) / 3 : m * 0.2;
      const kR = Ia * w0 * w0 * 1.3, cR = 2 * Ia * w0 * zeta;
      const av = b.angvel();
      b.resetTorques(false);
      b.addTorque({ x: kR * tmpV.x - cR * av.x, y: kR * tmpV.y - cR * av.y, z: kR * tmpV.z - cR * av.z }, false);
    }
  }

  function fling(wx, wy, strength = 1) {
    if (phase !== 'hold') return;
    const px = wx * S, py = wy * S;
    for (const L of letters) {
      const p = L.body.translation();
      const dx = p.x - px, dy = p.y - py;
      const dist = Math.hypot(dx, dy);
      if (dist > 5) continue;
      const f = (1 - dist / 5) * 7 * strength * L.m;
      const nx = dist > 1e-3 ? dx / dist : 0, ny = dist > 1e-3 ? dy / dist : 1;
      L.body.wakeUp();
      L.body.applyImpulse({ x: nx * f, y: ny * f + f * 0.35, z: (Math.random() - 0.3) * f * 0.5 }, true);
      L.body.applyTorqueImpulse({ x: (Math.random() - 0.5) * f * 0.35, y: (Math.random() - 0.5) * f * 0.35, z: (Math.random() - 0.5) * f * 0.25 }, true);
    }
  }

  section.addEventListener('pointerdown', e => {
    if (e.target.closest('a, button')) return;
    const r = section.getBoundingClientRect();
    fling(e.clientX - r.left - r.width / 2, r.height / 2 - (e.clientY - r.top));
  }, { passive: true });

  // ── Per-frame ──
  let lastRect = null;
  function update(dt, t, r) {
    lastRect = r;
    if (phase === 'idle') build(t);
    if (!world) return;

    const inside = pointer.inside && pointer.x >= r.left && pointer.x <= r.right && pointer.y >= r.top && pointer.y <= r.bottom;
    if (inside && (pointer.type !== 'touch' || pointer.down)) {
      cursorBody.setNextKinematicTranslation({ x: (pointer.x - r.left - r.width / 2) * S, y: (r.height / 2 - (pointer.y - r.top)) * S, z: 0 });
    } else {
      cursorBody.setNextKinematicTranslation({ x: 0, y: 80, z: 0 });
    }

    acc += dt;
    let steps = 0;
    while (acc >= 1 / 60 && steps < 4) {
      for (const L of letters) if (!L.on && t >= L.spawnAt) { L.on = true; L.body.setEnabled(true); }
      if (phase === 'drop' && letters.every(L => L.on) && t - letters[letters.length - 1].spawnAt > 1.7) enterHold();
      if (phase === 'hold') { watchJams(1 / 60); springs(); }
      world.step();
      acc -= 1 / 60; steps++;
    }

    for (const L of letters) {
      if (!L.on) continue;
      const p = L.body.translation(), q = L.body.rotation();
      L.mesh.position.set(p.x / S, p.y / S, p.z / S);
      L.mesh.quaternion.set(q.x, q.y, q.z, q.w);
    }

    l1.position.set(-r.width * 0.35 + Math.sin(t * 0.4) * 120, r.height * 0.3 + Math.cos(t * 0.3) * 80, 520);
    l2.position.set(r.width * 0.3 + Math.cos(t * 0.35) * 140, -r.height * 0.2 + Math.sin(t * 0.5) * 90, 480);

    // Fade the DOM name out only once a physical letter is actually inside the hero.
    if (!seen && letters.some(L => L.on && L.mesh.position.y < r.height / 2 + 40)) { seen = true; h1.classList.add('gl-hidden'); }
  }

  function onResize(widthChanged) {
    if (widthChanged && phase !== 'idle') { seen = false; phase = 'idle'; }
  }

  addView({ el: section, scene, camera, camZ: CAM_Z, update, onResize });
}
