// taa.js — temporal upsampling for the raymarched scene.
//
// The scene is fragment-bound: cost is essentially linear in drawing-buffer pixels, and
// measured at roughly 50 ms for 930k pixels on an AMD iGPU. Rendering fewer pixels is the
// only lever that does not change the art. So render the march at half linear resolution
// (a quarter of the pixels) with a sub-pixel jitter that rotates through a Halton
// sequence, and accumulate into a full-resolution history buffer that is reprojected each
// frame with the camera basis. Standing still the history converges to a full-resolution
// image; moving, reprojection keeps it close and the residual softness is masked by the
// motion that caused it.
//
// The scene shader writes distance-along-ray into alpha, which is what lets a pixel be
// turned back into a world position and looked up in the previous frame.

import * as THREE from 'three';
import { Pass, FullScreenQuad } from 'three/addons/postprocessing/Pass.js';

// Halton(2,3), the usual low-discrepancy choice: successive points stay far apart, so
// short accumulations cover the pixel evenly instead of clumping.
function halton(i, b) {
  let f = 1, r = 0;
  while (i > 0) { f /= b; r += f * (i % b); i = Math.floor(i / b); }
  return r;
}
const JITTER = Array.from({ length: 8 }, (_, i) => [halton(i + 1, 2) - 0.5, halton(i + 1, 3) - 0.5]);

const RESOLVE = {
  vertexShader: /* glsl */`
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
  `,
  fragmentShader: /* glsl */`
    precision highp float;
    varying vec2 vUv;
    uniform sampler2D tCur;        // half-res: rgb colour, a = distance along ray
    uniform sampler2D tHist;       // full-res accumulation
    uniform vec2  uCurTexel;       // 1 / half-res size
    uniform vec2  uHistTexel;      // 1 / full-res size
    uniform vec3  uCamPos, uRight, uUp, uFwd;
    uniform vec3  uPrevPos, uPrevRight, uPrevUp, uPrevFwd;
    uniform float uTanFov, uAspect, uFeedback, uHistValid;

    // Catmull-Rom history fetch (9 taps folded into bilinear ones). Plain bilinear
    // re-filters the history every moving frame, and at 88% feedback that compounds into
    // a visible blur while scrolling; this kernel keeps edges. Exact at texel centres, so
    // a still camera reads the history back unchanged.
    vec3 sampleHist(vec2 uv) {
      vec2 pos = uv / uHistTexel;
      vec2 p1 = floor(pos - 0.5) + 0.5;
      vec2 f = pos - p1;
      vec2 w0 = f * (-0.5 + f * (1.0 - 0.5 * f));
      vec2 w1 = 1.0 + f * f * (-2.5 + 1.5 * f);
      vec2 w2 = f * (0.5 + f * (2.0 - 1.5 * f));
      vec2 w3 = f * f * (-0.5 + 0.5 * f);
      vec2 w12 = w1 + w2;
      vec2 t0 = (p1 - 1.0) * uHistTexel, t3 = (p1 + 2.0) * uHistTexel;
      vec2 t12 = (p1 + w2 / w12) * uHistTexel;
      vec3 r = texture2D(tHist, vec2(t0.x,  t0.y)).rgb  * w0.x  * w0.y
             + texture2D(tHist, vec2(t12.x, t0.y)).rgb  * w12.x * w0.y
             + texture2D(tHist, vec2(t3.x,  t0.y)).rgb  * w3.x  * w0.y
             + texture2D(tHist, vec2(t0.x,  t12.y)).rgb * w0.x  * w12.y
             + texture2D(tHist, vec2(t12.x, t12.y)).rgb * w12.x * w12.y
             + texture2D(tHist, vec2(t3.x,  t12.y)).rgb * w3.x  * w12.y
             + texture2D(tHist, vec2(t0.x,  t3.y)).rgb  * w0.x  * w3.y
             + texture2D(tHist, vec2(t12.x, t3.y)).rgb  * w12.x * w3.y
             + texture2D(tHist, vec2(t3.x,  t3.y)).rgb  * w3.x  * w3.y;
      return max(r, vec3(0.0));
    }

    // The march is jittered by uJit low-res pixels, so low-res texel i holds the scene at
    // (i + 0.5 + uJit), not at its centre. Fetch the sample that actually landed nearest
    // this output pixel and weight it by how near it landed: a sample on top of the pixel
    // counts fully, one a pixel away barely. Bilinear upsampling instead treated every
    // sample as if it sat on the texel centre, which smeared each frame over two output
    // pixels and left the accumulated name soft and stair-stepped.
    uniform vec2 uJit;
    float nearestSample(vec2 uv, out vec2 suv) {
      vec2 pl = uv / uCurTexel - uJit;                // output pixel in un-jittered low-res texel space
      vec2 i = floor(pl);
      suv = (i + 0.5) * uCurTexel;
      vec2 d = (pl - i - 0.5) * (uCurTexel / uHistTexel);   // in output pixels
      return exp(-3.0 * dot(d, d));
    }

    void main() {
      vec4 cur = texture2D(tCur, vUv);
      vec2 suv;
      float sw = nearestSample(vUv, suv);
      vec3 c = cur.rgb;
      vec3 cs = texture2D(tCur, suv).rgb;

      // Rebuild this pixel's ray using the same convention as the scene shader, where
      // uv.y spans [-1,1] and uv.x spans [-aspect, aspect].
      vec2 s = vec2((vUv.x * 2.0 - 1.0) * uAspect, vUv.y * 2.0 - 1.0);
      vec3 rd = normalize(uRight * (s.x * uTanFov) + uUp * (s.y * uTanFov) + uFwd);
      vec3 wp = uCamPos + rd * cur.a;

      // Where was that world point on screen last frame?
      vec3 v = wp - uPrevPos;
      float z = dot(v, uPrevFwd);
      float w = uFeedback * uHistValid;
      vec2 h = vec2(-1.0);
      if (z > 1e-4) {
        h = vec2(dot(v, uPrevRight) / (z * uTanFov) / uAspect, dot(v, uPrevUp) / (z * uTanFov)) * 0.5 + 0.5;
      }
      if (h.x < 0.0 || h.x > 1.0 || h.y < 0.0 || h.y > 1.0) w = 0.0;

      if (w > 0.0) {
        // Clamp history into the colour range of the current neighbourhood. Without this
        // the reprojection drags colour across silhouettes and the glass smears — the
        // usual TAA ghosting, and worse here because the shading is all refraction.
        vec3 mn = min(c, cs), mx = max(c, cs);
        vec3 n1 = texture2D(tCur, suv + vec2(uCurTexel.x, 0.0)).rgb;
        vec3 n2 = texture2D(tCur, suv - vec2(uCurTexel.x, 0.0)).rgb;
        vec3 n3 = texture2D(tCur, suv + vec2(0.0, uCurTexel.y)).rgb;
        vec3 n4 = texture2D(tCur, suv - vec2(0.0, uCurTexel.y)).rgb;
        mn = min(mn, min(min(n1, n2), min(n3, n4)));
        mx = max(mx, max(max(n1, n2), max(n3, n4)));
        vec3 raw = sampleHist(h);
        vec3 hist = clamp(raw, mn, mx);
        // 4x keeps the average refresh rate near where plain (1 - feedback) put it: across
        // a jitter cycle the mean sample weight is about 0.25 at half res.
        float a = clamp((1.0 - w) * sw * 4.0, 0.0, 1.0);
        // Where the clamp had to pull history in, the content is moving (the glass breathes)
        // and history is mostly being discarded, so nearest-sample weighting would show the
        // half-res grid. Fall back to the plain bilinear blend there; the static name keeps
        // the sharp path.
        float moving = clamp(length(raw - hist) * 6.0, 0.0, 1.0);
        c = mix(mix(hist, cs, a), mix(c, hist, w), moving);
      }
      gl_FragColor = vec4(c, 1.0);
    }
  `,
};

export class TAAPass extends Pass {
  /** @param ratio linear render scale for the march, relative to output (0.5 = quarter the pixels) */
  constructor(scene, camera, sceneUniforms, ratio = 0.5) {
    super();
    this.scene = scene;
    this.camera = camera;
    this.u = sceneUniforms;
    this.ratio = ratio;
    this.needsSwap = true;
    this.frame = 0;
    this.valid = 0;

    const opts = { type: THREE.HalfFloatType, format: THREE.RGBAFormat,
                   minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, depthBuffer: false };
    this.low = new THREE.WebGLRenderTarget(1, 1, opts);
    this.hist = [new THREE.WebGLRenderTarget(1, 1, opts), new THREE.WebGLRenderTarget(1, 1, opts)];

    this.material = new THREE.ShaderMaterial({
      vertexShader: RESOLVE.vertexShader,
      fragmentShader: RESOLVE.fragmentShader,
      uniforms: {
        tCur: { value: null }, tHist: { value: null }, uCurTexel: { value: new THREE.Vector2() }, uHistTexel: { value: new THREE.Vector2() }, uJit: { value: new THREE.Vector2() },
        uCamPos: { value: new THREE.Vector3() }, uRight: { value: new THREE.Vector3() },
        uUp: { value: new THREE.Vector3() }, uFwd: { value: new THREE.Vector3() },
        uPrevPos: { value: new THREE.Vector3() }, uPrevRight: { value: new THREE.Vector3() },
        uPrevUp: { value: new THREE.Vector3() }, uPrevFwd: { value: new THREE.Vector3() },
        uTanFov: { value: 0.5 }, uAspect: { value: 1 }, uFeedback: { value: 0.88 }, uHistValid: { value: 0 },
      },
    });
    this.quad = new FullScreenQuad(this.material);
    this.copy = new FullScreenQuad(new THREE.ShaderMaterial({
      vertexShader: RESOLVE.vertexShader,
      fragmentShader: 'precision highp float; varying vec2 vUv; uniform sampler2D t; void main(){ gl_FragColor = texture2D(t, vUv); }',
      uniforms: { t: { value: null } },
    }));
  }

  /** Called each frame by main.js with the camera basis, before render(). */
  setCamera(pos, right, up, fwd, tanFov, aspect) {
    const u = this.material.uniforms;
    u.uPrevPos.value.copy(u.uCamPos.value); u.uPrevRight.value.copy(u.uRight.value);
    u.uPrevUp.value.copy(u.uUp.value); u.uPrevFwd.value.copy(u.uFwd.value);
    u.uCamPos.value.copy(pos); u.uRight.value.copy(right);
    u.uUp.value.copy(up); u.uFwd.value.copy(fwd);
    u.uTanFov.value = tanFov; u.uAspect.value = aspect;
  }

  setSize(w, h) {
    const lw = Math.max(1, Math.round(w * this.ratio)), lh = Math.max(1, Math.round(h * this.ratio));
    this.low.setSize(lw, lh);
    this.hist[0].setSize(w, h); this.hist[1].setSize(w, h);
    this.material.uniforms.uCurTexel.value.set(1 / lw, 1 / lh);
    this.material.uniforms.uHistTexel.value.set(1 / w, 1 / h);
    this.w = w; this.h = h;
    this.valid = 0;                                     // history is meaningless at a new size
  }

  // Forces one frame with no history blend. Same idea as the size-change reset above: call
  // this whenever `this.scene`'s content changes discontinuously (e.g. a material swap) so
  // the neighborhood clamp doesn't smear the old shading into the new frame.
  invalidate() { this.valid = 0; }

  // Switches the march resolution in place (main.js marches at full res while the page is
  // still: the glass never stops moving, so half-res history alone never resolves the name).
  setRatio(r) {
    if (r === this.ratio) return;
    this.ratio = r;
    if (this.w) this.setSize(this.w, this.h);
  }

  render(renderer, writeBuffer) {
    const u = this.material.uniforms;
    const lw = this.low.width, lh = this.low.height;

    // Jitter within one half-res pixel so successive frames sample different sub-pixel
    // positions; that is what makes the full-res history sharper than any single render.
    const j = JITTER[this.frame % JITTER.length];
    this.u.uJitter.value.set(j[0], j[1]);
    this.u.uRes.value.set(lw, lh);
    this.u.uAAPx.value = this.ratio;
    u.uJit.value.set(j[0], j[1]);

    const prevTarget = renderer.getRenderTarget();
    renderer.setRenderTarget(this.low);
    renderer.render(this.scene, this.camera);

    const src = this.hist[this.frame & 1], dst = this.hist[(this.frame + 1) & 1];
    u.tCur.value = this.low.texture;
    u.tHist.value = src.texture;
    u.uHistValid.value = this.valid;

    renderer.setRenderTarget(dst);
    this.quad.render(renderer);

    this.copy.material.uniforms.t.value = dst.texture;
    renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
    this.copy.render(renderer);

    renderer.setRenderTarget(prevTarget);
    this.u.uJitter.value.set(0, 0);
    this.frame++;
    this.valid = 1;
  }

  dispose() {
    this.low.dispose(); this.hist[0].dispose(); this.hist[1].dispose();
    this.material.dispose(); this.quad.dispose(); this.copy.dispose();
  }
}
