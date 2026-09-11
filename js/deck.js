// deck.js — projects as a 3D fan of glass cards. The hidden DOM grid stays the data source and
// fallback; a DOM detail panel beside the stage shows the active card's text.

const CAM_Z = 1400;

const VERT = `
varying vec2 vUv; varying vec3 vN; varying vec3 vV;
void main () {
  vUv = uv;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vN = normalize(normalMatrix * normal);
  vV = -mv.xyz;
  gl_Position = projectionMatrix * mv;
}`;

const FRAG = `
uniform sampler2D map; uniform vec2 size; uniform float radius; uniform float hover; uniform float dim;
varying vec2 vUv; varying vec3 vN; varying vec3 vV;
float rbox (vec2 p, vec2 b, float r) { vec2 q = abs(p) - b + r; return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r; }
void main () {
  vec2 p = (vUv - 0.5) * size;
  float d = rbox(p, size * 0.5, radius);
  float aa = fwidth(d);
  float inside = 1.0 - smoothstep(-aa, aa, d);
  float ring = 1.0 - smoothstep(0.0, 1.8 + aa, abs(d + 1.4));
  vec3 tex = texture2D(map, vUv).rgb;
  float fr = pow(1.0 - clamp(dot(normalize(vN), normalize(vV)), 0.0, 1.0), 3.0);
  vec3 col = tex * mix(1.0, 0.5, dim) * (1.0 + 0.1 * hover);
  col += vec3(0.55, 0.45, 0.9) * fr * 0.4;
  col += vec3(1.0) * ring * (0.22 + 0.3 * hover) * mix(1.0, 0.5, dim);
  gl_FragColor = vec4(col, inside);
}`;

function loadCover(src, W, H, label) {
  return new Promise(resolve => {
    const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
    const ctx = cv.getContext('2d');
    const fallback = () => {
      ctx.fillStyle = '#0a0e17'; ctx.fillRect(0, 0, W, H);
      ctx.fillStyle = 'rgba(255,255,255,0.7)'; ctx.font = '800 64px Syne, sans-serif';
      ctx.textAlign = 'center'; ctx.fillText(label || '', W / 2, H / 2 + 22);
      resolve(cv);
    };
    if (!src) return fallback();
    const img = new Image();
    img.onload = () => {
      const s = Math.max(W / img.naturalWidth, H / img.naturalHeight);
      const w = img.naturalWidth * s, h = img.naturalHeight * s;
      ctx.fillStyle = '#0a0e17'; ctx.fillRect(0, 0, W, H);
      ctx.drawImage(img, (W - w) / 2, 0, w, h);      // cover, top-aligned like the CSS
      resolve(cv);
    };
    img.onerror = fallback;
    img.src = src;
  });
}

export async function initDeck({ THREE, renderer, pointer, addView }) {
  const section = document.getElementById('projects');
  const stage = document.getElementById('deck-stage');
  const detail = document.getElementById('deck-detail');
  const grid = section?.querySelector('.projects-grid');
  if (!section || !stage || !detail || !grid) return;

  const cards = [...grid.querySelectorAll('.project-card')].map(a => ({
    href: a.href,
    img: a.querySelector('img')?.getAttribute('src'),
    num: a.querySelector('.card-num')?.textContent.trim() || '',
    title: a.querySelector('h3')?.textContent.trim() || '',
    desc: a.querySelector('p')?.textContent.trim() || '',
    tags: [...a.querySelectorAll('.card-tags span')].map(s => s.textContent.trim()),
    link: a.querySelector('.card-link')?.textContent.trim() || '',
  }));
  if (cards.length < 2) return;

  const canvases = await Promise.all(cards.map(c => loadCover(c.img, 1024, 640, c.title)));

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(30, 1, 10, 6000);
  camera.position.set(0, 0, CAM_Z);

  const plane = new THREE.PlaneGeometry(1, 1);
  const aniso = Math.min(8, renderer.capabilities.getMaxAnisotropy());

  // Soft shadow sprite behind each card.
  const shadowCv = document.createElement('canvas'); shadowCv.width = shadowCv.height = 256;
  const sctx = shadowCv.getContext('2d');
  const grad = sctx.createRadialGradient(128, 128, 20, 128, 128, 128);
  grad.addColorStop(0, 'rgba(0,0,0,0.6)'); grad.addColorStop(1, 'rgba(0,0,0,0)');
  sctx.fillStyle = grad; sctx.fillRect(0, 0, 256, 256);
  const shadowTex = new THREE.CanvasTexture(shadowCv);

  const meshes = cards.map((c, i) => {
    const tex = new THREE.CanvasTexture(canvases[i]);
    tex.anisotropy = aniso; tex.generateMipmaps = true; tex.minFilter = THREE.LinearMipmapLinearFilter;
    const mat = new THREE.ShaderMaterial({
      vertexShader: VERT, fragmentShader: FRAG, transparent: true, side: THREE.DoubleSide,
      uniforms: { map: { value: tex }, size: { value: new THREE.Vector2(400, 250) }, radius: { value: 18 }, hover: { value: 0 }, dim: { value: 0 } },
    });
    const group = new THREE.Group();
    const mesh = new THREE.Mesh(plane, mat);
    mesh.userData.index = i;
    const shadow = new THREE.Mesh(plane, new THREE.MeshBasicMaterial({ map: shadowTex, transparent: true, depthWrite: false, opacity: 0.9 }));
    shadow.position.set(0, -24, -40);
    group.add(shadow, mesh);
    scene.add(group);
    return { group, mesh, shadow, mat, hover: 0, tiltX: 0, tiltY: 0 };
  });

  // ── Detail panel ──
  let shown = -1;
  function renderDetail(i) {
    const c = cards[i];
    detail.innerHTML = `
      <div class="card-num">${c.num}</div>
      <h3>${c.title}</h3>
      <p>${c.desc}</p>
      <div class="card-tags">${c.tags.map(t => `<span>${t}</span>`).join('')}</div>
      <a class="card-link" href="${c.href}" target="_blank" rel="noopener">${c.link}</a>
      <div class="deck-dots" role="tablist" aria-label="Projects">
        ${cards.map((_, k) => `<button type="button" role="tab" aria-selected="${k === i}" data-i="${k}" aria-label="${cards[k].title}"></button>`).join('')}
      </div>`;
    const ring = document.getElementById('cursor-ring'), dot = document.getElementById('cursor-dot');
    detail.querySelectorAll('a, button').forEach(el => {
      el.addEventListener('pointerenter', () => { ring?.classList.add('hover'); dot?.classList.add('hover'); });
      el.addEventListener('pointerleave', () => { ring?.classList.remove('hover'); dot?.classList.remove('hover'); });
    });
    detail.querySelectorAll('.deck-dots button').forEach(b => b.addEventListener('click', () => scrollToCard(+b.dataset.i)));
  }
  let swapTimer = 0;
  function showDetail(i) {
    if (i === shown) return;
    const first = shown < 0;
    shown = i;
    if (first) { renderDetail(i); return; }
    detail.classList.add('swap');
    clearTimeout(swapTimer);
    swapTimer = setTimeout(() => { renderDetail(i); detail.classList.remove('swap'); }, 160);
  }

  function scrollRange() {
    const r = section.getBoundingClientRect();
    const top = r.top + scrollY, len = Math.max(1, r.height - innerHeight);
    return { top, len };
  }
  function scrollToCard(i) {
    const { top, len } = scrollRange();
    scrollTo({ top: top + (i / (cards.length - 1)) * len, behavior: 'smooth' });
  }

  // ── Interaction ──
  const ray = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  let hovered = -1, stageRect = null, inStage = false;
  const ring = document.getElementById('cursor-ring'), dot = document.getElementById('cursor-dot');

  function pick(clientX, clientY) {
    if (!stageRect) return -1;
    ndc.set(((clientX - stageRect.left) / stageRect.width) * 2 - 1, -((clientY - stageRect.top) / stageRect.height) * 2 + 1);
    ray.setFromCamera(ndc, camera);
    const hits = ray.intersectObjects(meshes.map(m => m.mesh), false);
    return hits.length ? hits[0].object.userData.index : -1;
  }
  stage.addEventListener('pointermove', e => { inStage = true; hovered = pick(e.clientX, e.clientY); }, { passive: true });
  stage.addEventListener('pointerleave', () => { inStage = false; hovered = -1; });
  stage.addEventListener('click', e => {
    const i = pick(e.clientX, e.clientY);
    if (i >= 0) window.open(cards[i].href, '_blank', 'noopener');
  });
  window.addEventListener('keydown', e => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    const r = section.getBoundingClientRect();
    if (r.top > innerHeight * 0.5 || r.bottom < innerHeight * 0.5) return;
    e.preventDefault();
    scrollToCard(Math.min(cards.length - 1, Math.max(0, Math.round(active) + (e.key === 'ArrowRight' ? 1 : -1))));
  });

  let active = 0, ringOn = false;
  function update(dt, t, r) {
    stageRect = r;
    const { len } = scrollRange();
    const sr = section.getBoundingClientRect();
    const p = Math.min(1, Math.max(0, -sr.top / len));
    const target = p * (cards.length - 1);
    active += (target - active) * Math.min(1, dt * 7);

    const cw = Math.min(560, Math.max(240, r.width * 0.58)), ch = cw * 0.625;
    const k = Math.min(1, dt * 9);

    meshes.forEach((m, i) => {
      const o = i - active;
      const ao = Math.abs(o);
      const isHov = hovered === i;
      m.hover += ((isHov ? 1 : 0) - m.hover) * k;
      const bob = Math.sin(t * 0.9 + i * 1.7) * 6;
      const cap = Math.min(ao, 2.5);
      const x = cw * 0.42 * Math.tanh(o * 0.75);
      const y = -cap * cw * 0.03 + bob + m.hover * 14;
      const z = -cap * cw * 0.42 + m.hover * 60;
      const sc = 1 - cap * 0.09;
      let tx = 0, ty = 0;
      if (isHov && stageRect) {
        const px = ((pointer.x - stageRect.left) / stageRect.width - 0.5) * 2;
        const py = ((pointer.y - stageRect.top) / stageRect.height - 0.5) * 2;
        tx = -py * 0.14; ty = px * 0.16;
      }
      m.tiltX += (tx - m.tiltX) * k; m.tiltY += (ty - m.tiltY) * k;
      m.group.position.set(x, y, z);
      m.group.scale.setScalar(sc);
      m.group.rotation.set(m.tiltX, -Math.tanh(o * 0.8) * 0.42 + m.tiltY, 0);
      m.mesh.scale.set(cw, ch, 1);
      m.shadow.scale.set(cw * 1.35, ch * 1.45, 1);
      m.shadow.material.opacity = 0.9 - Math.min(1, ao) * 0.5;
      m.mat.uniforms.size.value.set(cw, ch);
      m.mat.uniforms.hover.value = m.hover;
      m.mat.uniforms.dim.value = Math.min(1, ao) * 0.85;
    });

    const want = hovered >= 0 && inStage;
    if (want !== ringOn) { ringOn = want; ring?.classList.toggle('hover', want); dot?.classList.toggle('hover', want); }

    showDetail(hovered >= 0 ? hovered : Math.round(active));
  }

  section.classList.add('deck-active');
  detail.hidden = false;
  addView({ el: stage, scene, camera, camZ: CAM_Z, update });
}
