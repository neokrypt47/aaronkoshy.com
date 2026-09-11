// fluid.js — library-free WebGL2 stable-fluids background.
// Advect → vorticity confinement → divergence → Jacobi pressure → gradient subtract, separate dye field.

const VERT = `#version 300 es
precision highp float;
in vec2 aPosition;
out vec2 vUv, vL, vR, vT, vB;
uniform vec2 texelSize;
void main () {
  vUv = aPosition * 0.5 + 0.5;
  vL = vUv - vec2(texelSize.x, 0.0);
  vR = vUv + vec2(texelSize.x, 0.0);
  vT = vUv + vec2(0.0, texelSize.y);
  vB = vUv - vec2(0.0, texelSize.y);
  gl_Position = vec4(aPosition, 0.0, 1.0);
}`;

const HEAD = `#version 300 es
precision highp float;
precision highp sampler2D;
in vec2 vUv, vL, vR, vT, vB;
out vec4 outColor;
`;

const FRAG = {
  clear: HEAD + `
uniform sampler2D uTexture; uniform float value;
void main () { outColor = value * texture(uTexture, vUv); }`,

  splat: HEAD + `
uniform sampler2D uTarget; uniform float aspectRatio; uniform vec3 color; uniform vec2 point; uniform float radius;
void main () {
  vec2 p = vUv - point; p.x *= aspectRatio;
  vec3 splat = exp(-dot(p, p) / radius) * color;
  vec3 base = texture(uTarget, vUv).xyz;
  outColor = vec4(base + splat, 1.0);
}`,

  advection: HEAD + `
uniform sampler2D uVelocity; uniform sampler2D uSource; uniform vec2 texelSize; uniform float dt; uniform float dissipation;
void main () {
  vec2 coord = vUv - dt * texture(uVelocity, vUv).xy * texelSize;
  vec4 result = texture(uSource, coord);
  float decay = 1.0 + dissipation * dt;
  outColor = result / decay;
}`,

  divergence: HEAD + `
uniform sampler2D uVelocity;
void main () {
  float L = texture(uVelocity, vL).x, R = texture(uVelocity, vR).x;
  float T = texture(uVelocity, vT).y, B = texture(uVelocity, vB).y;
  vec2 C = texture(uVelocity, vUv).xy;
  if (vL.x < 0.0) { L = -C.x; } if (vR.x > 1.0) { R = -C.x; }
  if (vT.y > 1.0) { T = -C.y; } if (vB.y < 0.0) { B = -C.y; }
  outColor = vec4(0.5 * (R - L + T - B), 0.0, 0.0, 1.0);
}`,

  curl: HEAD + `
uniform sampler2D uVelocity;
void main () {
  float L = texture(uVelocity, vL).y, R = texture(uVelocity, vR).y;
  float T = texture(uVelocity, vT).x, B = texture(uVelocity, vB).x;
  outColor = vec4(0.5 * (R - L - T + B), 0.0, 0.0, 1.0);
}`,

  vorticity: HEAD + `
uniform sampler2D uVelocity; uniform sampler2D uCurl; uniform float curl; uniform float dt;
void main () {
  float L = texture(uCurl, vL).x, R = texture(uCurl, vR).x;
  float T = texture(uCurl, vT).x, B = texture(uCurl, vB).x;
  float C = texture(uCurl, vUv).x;
  vec2 force = 0.5 * vec2(abs(T) - abs(B), abs(R) - abs(L));
  force /= length(force) + 0.0001;
  force *= curl * C; force.y *= -1.0;
  vec2 vel = texture(uVelocity, vUv).xy + force * dt;
  outColor = vec4(clamp(vel, -1000.0, 1000.0), 0.0, 1.0);
}`,

  pressure: HEAD + `
uniform sampler2D uPressure; uniform sampler2D uDivergence;
void main () {
  float L = texture(uPressure, vL).x, R = texture(uPressure, vR).x;
  float T = texture(uPressure, vT).x, B = texture(uPressure, vB).x;
  float div = texture(uDivergence, vUv).x;
  outColor = vec4((L + R + B + T - div) * 0.25, 0.0, 0.0, 1.0);
}`,

  gradient: HEAD + `
uniform sampler2D uPressure; uniform sampler2D uVelocity;
void main () {
  float L = texture(uPressure, vL).x, R = texture(uPressure, vR).x;
  float T = texture(uPressure, vT).x, B = texture(uPressure, vB).x;
  vec2 v = texture(uVelocity, vUv).xy - vec2(R - L, T - B);
  outColor = vec4(v, 0.0, 1.0);
}`,

  display: HEAD + `
uniform sampler2D uTexture; uniform vec3 bg1; uniform vec3 bg2;
void main () {
  vec3 c = texture(uTexture, vUv).rgb;
  c = c * 0.9 / (1.0 + c * 0.75);
  float t = clamp((vUv.x + (1.0 - vUv.y)) * 0.5, 0.0, 1.0);
  vec3 bg = mix(bg1, bg2, t);
  outColor = vec4(bg + c, 1.0);
}`,
};

function cssRGB(name, fallback) {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const m = v.match(/(\d+)\D+(\d+)\D+(\d+)/);
  return m ? [m[1] / 255, m[2] / 255, m[3] / 255] : fallback;
}

export function createFluid(canvas, { pointer, mobile }) {
  const gl = canvas.getContext('webgl2', { alpha: false, depth: false, stencil: false, antialias: false, powerPreference: 'high-performance' });
  if (!gl) return null;
  if (!gl.getExtension('EXT_color_buffer_float')) return null;

  const cfg = {
    SIM_RES: mobile ? 96 : 128,
    DYE_RES: mobile ? 256 : 512,
    DENSITY_DISSIPATION: 0.16,
    VELOCITY_DISSIPATION: 0.2,
    PRESSURE: 0.8,
    PRESSURE_ITER: mobile ? 12 : 18,
    CURL: 26,
    SPLAT_RADIUS: 1.7,
    SPLAT_FORCE: 5200,
  };

  const palette = ['--color1', '--color2', '--color3', '--color4', '--color5', '--color-interactive']
    .map(n => cssRGB(n, [0.4, 0.3, 1]));
  const bg1 = cssRGB('--color-bg1', [80 / 255, 0, 140 / 255]).map(v => v * 0.85);
  const bg2 = cssRGB('--color-bg2', [0, 12 / 255, 70 / 255]);

  // ── GL helpers ──
  function compile(type, src) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
    return s;
  }
  const vs = compile(gl.VERTEX_SHADER, VERT);
  function program(fsSrc) {
    const p = gl.createProgram();
    gl.attachShader(p, vs); gl.attachShader(p, compile(gl.FRAGMENT_SHADER, fsSrc)); gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
    const u = {};
    const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < n; i++) { const name = gl.getActiveUniform(p, i).name; u[name] = gl.getUniformLocation(p, name); }
    return { p, u, bind() { gl.useProgram(p); } };
  }
  const P = {};
  for (const k in FRAG) P[k] = program(FRAG[k]);

  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);
  const vbo = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

  function blit(target) {
    if (target) { gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo); gl.viewport(0, 0, target.w, target.h); }
    else { gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight); }
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  function fbo(w, h) {
    const tex = gl.createTexture();
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, w, h, 0, gl.RGBA, gl.HALF_FLOAT, null);
    const f = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, f);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) throw new Error('fluid: FBO incomplete');
    gl.viewport(0, 0, w, h); gl.clearColor(0, 0, 0, 1); gl.clear(gl.COLOR_BUFFER_BIT);
    return { tex, fbo: f, w, h, tx: 1 / w, ty: 1 / h, attach(id) { gl.activeTexture(gl.TEXTURE0 + id); gl.bindTexture(gl.TEXTURE_2D, tex); return id; } };
  }
  function dfbo(w, h) {
    let a = fbo(w, h), b = fbo(w, h);
    return { w, h, tx: 1 / w, ty: 1 / h, get read() { return a; }, get write() { return b; }, swap() { const t = a; a = b; b = t; } };
  }
  function res(base) {
    const aspect = gl.drawingBufferWidth / gl.drawingBufferHeight;
    const min = Math.round(base), max = Math.round(base * Math.max(aspect, 1 / aspect));
    return aspect >= 1 ? { w: max, h: min } : { w: min, h: max };
  }

  let dye, velocity, divergence, curl, pressure;
  function initFBOs() {
    const s = res(cfg.SIM_RES), d = res(cfg.DYE_RES);
    dye = dfbo(d.w, d.h); velocity = dfbo(s.w, s.h);
    divergence = fbo(s.w, s.h); curl = fbo(s.w, s.h); pressure = dfbo(s.w, s.h);
  }
  function sizeCanvas() {
    const w = Math.max(1, Math.round(innerWidth)), h = Math.max(1, Math.round(innerHeight));
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; return true; }
    return false;
  }
  sizeCanvas();
  initFBOs();

  // ── Splats ──
  function splat(x, y, dx, dy, color, radiusScale = 1) {
    const aspect = canvas.width / canvas.height;
    let r = cfg.SPLAT_RADIUS / 100 * radiusScale; if (aspect > 1) r *= aspect;
    P.splat.bind();
    gl.uniform1i(P.splat.u.uTarget, velocity.read.attach(0));
    gl.uniform1f(P.splat.u.aspectRatio, aspect);
    gl.uniform2f(P.splat.u.point, x, y);
    gl.uniform3f(P.splat.u.color, dx, dy, 0);
    gl.uniform1f(P.splat.u.radius, r);
    blit(velocity.write); velocity.swap();
    gl.uniform1i(P.splat.u.uTarget, dye.read.attach(0));
    gl.uniform3f(P.splat.u.color, color[0], color[1], color[2]);
    blit(dye.write); dye.swap();
  }

  let colorPhase = Math.random() * palette.length;
  function paletteColor(phase, gain) {
    const i = Math.floor(phase) % palette.length, j = (i + 1) % palette.length, f = phase - Math.floor(phase);
    const a = palette[i], b = palette[j];
    return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f].map(v => v * gain);
  }

  // Seed: a few soft blobs so the first frame is not empty.
  for (let i = 0; i < 5; i++) {
    splat(0.15 + Math.random() * 0.7, 0.2 + Math.random() * 0.6, (Math.random() - 0.5) * 900, (Math.random() - 0.5) * 900, paletteColor(i * 1.3, 0.9));
  }

  let idleTimer = 1.2;
  let lastX = pointer.x, lastY = pointer.y, lastSeq = pointer.seq;

  function step(dt, t) {
    dt = Math.min(dt, 1 / 30);
    colorPhase += dt * 0.12;

    idleTimer -= dt;
    if (idleTimer <= 0) {
      idleTimer = 1.4 + Math.random() * 2.0;
      const n = 1 + (Math.random() * 2 | 0);
      for (let i = 0; i < n; i++) {
        splat(0.1 + Math.random() * 0.8, 0.1 + Math.random() * 0.8, (Math.random() - 0.5) * 1300, (Math.random() - 0.5) * 1300, paletteColor(colorPhase + i * 1.7, 0.6));
      }
    }

    if (pointer.seq !== lastSeq) {
      lastSeq = pointer.seq;
      const dx = (pointer.x - lastX) / canvas.width, dy = (pointer.y - lastY) / canvas.height;
      lastX = pointer.x; lastY = pointer.y;
      if (Math.abs(dx) + Math.abs(dy) > 0) {
        splat(pointer.x / canvas.width, 1 - pointer.y / canvas.height, dx * cfg.SPLAT_FORCE, -dy * cfg.SPLAT_FORCE, paletteColor(colorPhase, 0.14), 0.45);
      }
    }

    gl.disable(gl.BLEND);

    P.curl.bind();
    gl.uniform2f(P.curl.u.texelSize, velocity.tx, velocity.ty);
    gl.uniform1i(P.curl.u.uVelocity, velocity.read.attach(0));
    blit(curl);

    P.vorticity.bind();
    gl.uniform2f(P.vorticity.u.texelSize, velocity.tx, velocity.ty);
    gl.uniform1i(P.vorticity.u.uVelocity, velocity.read.attach(0));
    gl.uniform1i(P.vorticity.u.uCurl, curl.attach(1));
    gl.uniform1f(P.vorticity.u.curl, cfg.CURL);
    gl.uniform1f(P.vorticity.u.dt, dt);
    blit(velocity.write); velocity.swap();

    P.divergence.bind();
    gl.uniform2f(P.divergence.u.texelSize, velocity.tx, velocity.ty);
    gl.uniform1i(P.divergence.u.uVelocity, velocity.read.attach(0));
    blit(divergence);

    P.clear.bind();
    gl.uniform1i(P.clear.u.uTexture, pressure.read.attach(0));
    gl.uniform1f(P.clear.u.value, cfg.PRESSURE);
    blit(pressure.write); pressure.swap();

    P.pressure.bind();
    gl.uniform2f(P.pressure.u.texelSize, velocity.tx, velocity.ty);
    gl.uniform1i(P.pressure.u.uDivergence, divergence.attach(0));
    for (let i = 0; i < cfg.PRESSURE_ITER; i++) {
      gl.uniform1i(P.pressure.u.uPressure, pressure.read.attach(1));
      blit(pressure.write); pressure.swap();
    }

    P.gradient.bind();
    gl.uniform2f(P.gradient.u.texelSize, velocity.tx, velocity.ty);
    gl.uniform1i(P.gradient.u.uPressure, pressure.read.attach(0));
    gl.uniform1i(P.gradient.u.uVelocity, velocity.read.attach(1));
    blit(velocity.write); velocity.swap();

    P.advection.bind();
    gl.uniform2f(P.advection.u.texelSize, velocity.tx, velocity.ty);
    const vId = velocity.read.attach(0);
    gl.uniform1i(P.advection.u.uVelocity, vId);
    gl.uniform1i(P.advection.u.uSource, vId);
    gl.uniform1f(P.advection.u.dt, dt);
    gl.uniform1f(P.advection.u.dissipation, cfg.VELOCITY_DISSIPATION);
    blit(velocity.write); velocity.swap();

    gl.uniform1i(P.advection.u.uVelocity, velocity.read.attach(0));
    gl.uniform1i(P.advection.u.uSource, dye.read.attach(1));
    gl.uniform1f(P.advection.u.dissipation, cfg.DENSITY_DISSIPATION);
    blit(dye.write); dye.swap();

    P.display.bind();
    gl.uniform2f(P.display.u.texelSize, 1 / canvas.width, 1 / canvas.height);
    gl.uniform1i(P.display.u.uTexture, dye.read.attach(0));
    gl.uniform3f(P.display.u.bg1, bg1[0], bg1[1], bg1[2]);
    gl.uniform3f(P.display.u.bg2, bg2[0], bg2[1], bg2[2]);
    blit(null);
  }

  function resize() {
    if (sizeCanvas()) initFBOs();
  }

  return { step, resize, splat };
}
