// shaders.js — the raymarched liquid-glass scene (GLSL ES 3.0 via three's GLSL3 mode).

export const VERT = /* glsl */`
void main() { gl_Position = vec4(position, 1.0); }
`;

// FRAG_TEMPLATE is built into two variants (see buildFrag below): the full-quality FRAG
// (unchanged output) and FRAG_FAST, a cheap-to-compile placeholder used while the full
// shader compiles in the background (see js/main.js's progressive shader swap). The
// expensive-to-compile parts are the loop bounds below (MAXB, the raymarch step count,
// the marchInside step count) — these are compile-time literals ANGLE has to unroll, not
// just runtime limits, which is why they're templated rather than left as runtime uniforms.
const FRAG_TEMPLATE = /* glsl */`
#define MAXB __MAXB__
precision highp float;
precision highp sampler2D;
out vec4 fragColor;

uniform vec2  uRes;
uniform float uTime;
uniform vec3  uCamPos;
uniform mat3  uCamMat;
uniform float uTanFov;

uniform vec4  uBlobs[MAXB];
uniform int   uNB;
uniform vec4  uCursor;
uniform vec3  uCoreA; uniform vec3 uCoreAHalf; uniform float uCoreAOn;
uniform vec3  uCoreB; uniform vec3 uCoreBHalf; uniform float uCoreBOn;
uniform vec4  uBoundA; uniform vec4 uBoundB;   // bounding spheres of the two active clusters (xyz, r)

uniform sampler2D uTexA; uniform vec3 uTextAPos; uniform vec2 uTextASize; uniform float uTextAOn; uniform float uTextAFade;
uniform sampler2D uTexB; uniform vec3 uTextBPos; uniform vec2 uTextBSize; uniform float uTextBOn; uniform float uTextBFade;
uniform float uTextDepth;

uniform vec4  uSlab[4];
uniform vec3  uSlabHalf;
uniform float uSlabOn;
uniform float uSlabScale;
uniform sampler2D uAtlas;

uniform float uIor;
uniform vec3  uAbsorb;
uniform float uDisp;
uniform int   uSteps;
uniform int   uISteps;
uniform vec2  uJitter;   // sub-pixel ray offset, in render pixels (temporal upsampling)

// ── Tunable look constants (defaults match the original hand-picked values exactly;
// exposed as uniforms only so the live tune panel — js/tune.js, dev-only — can drag
// them. Nothing here changes the default render. ──
uniform vec3  uSkyLow;    uniform vec3 uSkyHigh;    // vertical sky gradient
uniform vec3  uFloorGlow; uniform vec3 uHorizonColor;
uniform vec3  uSb0Color;  uniform float uSb0I;      // three softbox highlights
uniform vec3  uSb1Color;  uniform float uSb1I;
uniform vec3  uSb2Color;  uniform float uSb2I;
uniform vec3  uTextColor;
uniform vec3  uTIRColor;
uniform vec3  uGlowColor;
uniform float uHaloMin;   uniform float uHaloRange;
uniform float uVignette;

// ── SDF helpers ──
float smin(float a, float b, float k) {
  float h = clamp(0.5 + 0.5 * (b - a) / k, 0.0, 1.0);
  return mix(b, a, h) - k * h * (1.0 - h);
}
float sdBox(vec3 p, vec3 b) { vec3 q = abs(p) - b; return length(max(q, 0.0)) + min(max(q.x, max(q.y, q.z)), 0.0); }
float sdRBox(vec3 p, vec3 b, float r) { vec3 q = abs(p) - b + r; return length(max(q, 0.0)) + min(max(q.x, max(q.y, q.z)), 0.0) - r; }

// NB: an exact squared-distance early-out here (skip the sqrt/smin when a blob is too
// far to change the result) measured SLOWER — 56.7 ms vs 48.4 ms — and pushed the ANGLE
// shader compile past 20 s. A continue in this dynamically-bounded loop stops it being
// unrolled, and the branch divergence costs more than the sqrt it saves. Don't re-add it.
float sdLiquid(vec3 p) {
  float d = 1e5;
  if (uCoreAOn > 0.5) d = sdRBox(p - uCoreA, uCoreAHalf, 0.8);
  if (uCoreBOn > 0.5) d = smin(d, sdRBox(p - uCoreB, uCoreBHalf, 0.8), 1.2);
  for (int i = 0; i < MAXB; i++) {
    if (i >= uNB) break;
    vec4 b = uBlobs[i];
    d = smin(d, length(p - b.xyz) - b.w, 1.3);
  }
  if (uCursor.w > 0.001) d = smin(d, length(p - uCursor.xyz) - uCursor.w, 0.85);
  return d;
}

float sdText(sampler2D tex, vec3 p, vec3 pos, vec2 size, float fade) {
  vec3 l = p - pos;
  float bb = sdBox(l, vec3(size * 0.5, uTextDepth));
  if (bb > 0.6) return bb + fade;                       // cheap conservative bound outside the text box
  vec2 uv = l.xy / size + 0.5;
  float v = texture(tex, clamp(uv, 0.0, 1.0)).r * size.x;
  vec2 q = abs(l.xy) - size * 0.5;
  v += length(max(q, 0.0));
  vec2 w = vec2(v, abs(l.z) - uTextDepth);
  return min(max(w.x, w.y), 0.0) + length(max(w, 0.0)) - 0.012 + fade;  // tiny rounding only; keeps counters open
}

float sdSlab(vec3 p, vec3 c) {
  vec3 q = abs(p - c) - uSlabHalf * uSlabScale + 0.08;
  return length(max(q, 0.0)) + min(max(q.x, max(q.y, q.z)), 0.0) - 0.08;
}

float sdSolid(vec3 p, out int id) {
  float d = 1e5; id = -1;
  if (uTextAOn > 0.5) { float t = sdText(uTexA, p, uTextAPos, uTextASize, uTextAFade); if (t < d) { d = t; id = 0; } }
  if (uTextBOn > 0.5) { float t = sdText(uTexB, p, uTextBPos, uTextBSize, uTextBFade); if (t < d) { d = t; id = 0; } }
  if (uSlabOn > 0.5) {
    for (int i = 0; i < 4; i++) { float s = sdSlab(p, uSlab[i].xyz); if (s < d) { d = s; id = 1 + i; } }
  }
  return d;
}

// Analytic gradient. For smin(a,b,k) the derivative is exactly mix(gb, ga, h) with the
// same h the distance uses: differentiating mix(b,a,h) - k*h*(1-h) leaves a correction
// term ((a-b) - k*(1-2h)) * dh/dp, and in the unclamped range (b-a) == k*(2h-1), so that
// bracket is identically zero. Clamped, dh/dp is zero and mix picks the surviving branch.
// So one pass yields both, replacing the 4 sdLiquid calls a tetrahedron normal needed —
// and normals were 8 of the ~10 sdLiquid evaluations each pixel was doing.
vec3 gRBox(vec3 pl, vec3 b, float r) {
  vec3 s = sign(pl);
  vec3 q = abs(pl) - b + r;
  vec3 mq = max(q, 0.0);
  float l = length(mq);
  if (l > 1e-5) return s * (mq / l);
  float m = max(q.x, max(q.y, q.z));                       // inside: push along the deepest axis
  return s * vec3(step(m, q.x), step(m, q.y), step(m, q.z));
}

float sdLiquidG(vec3 p, out vec3 g) {
  float d = 1e5; g = vec3(0.0, 0.0, 1.0);
  if (uCoreAOn > 0.5) {
    vec3 l = p - uCoreA;
    d = sdRBox(l, uCoreAHalf, 0.8); g = gRBox(l, uCoreAHalf, 0.8);
  }
  if (uCoreBOn > 0.5) {
    vec3 l = p - uCoreB;
    float db = sdRBox(l, uCoreBHalf, 0.8); vec3 gb = gRBox(l, uCoreBHalf, 0.8);
    float h = clamp(0.5 + 0.5 * (db - d) / 1.2, 0.0, 1.0);
    d = mix(db, d, h) - 1.2 * h * (1.0 - h); g = mix(gb, g, h);
  }
  for (int i = 0; i < MAXB; i++) {
    if (i >= uNB) break;
    vec4 b = uBlobs[i];
    vec3 dv = p - b.xyz; float L = length(dv);
    float db = L - b.w; vec3 gb = dv / max(L, 1e-6);
    float h = clamp(0.5 + 0.5 * (db - d) / 1.3, 0.0, 1.0);
    d = mix(db, d, h) - 1.3 * h * (1.0 - h); g = mix(gb, g, h);
  }
  if (uCursor.w > 0.001) {
    vec3 dv = p - uCursor.xyz; float L = length(dv);
    float db = L - uCursor.w; vec3 gb = dv / max(L, 1e-6);
    float h = clamp(0.5 + 0.5 * (db - d) / 0.85, 0.0, 1.0);
    d = mix(db, d, h) - 0.85 * h * (1.0 - h); g = mix(gb, g, h);
  }
  return d;
}
vec3 nLiquid(vec3 p) { vec3 g; sdLiquidG(p, g); return normalize(g); }
// Tetrahedron, 4 taps rather than 6 central differences — each tap is two texture
// fetches through sdText, so this drops 4 of them per shaded solid pixel.
vec3 nSolid(vec3 p) {
  int id; const vec2 k = vec2(1.0, -1.0); const float h = 0.008;
  return normalize(k.xyy * sdSolid(p + k.xyy * h, id) + k.yyx * sdSolid(p + k.yyx * h, id) +
                   k.yxy * sdSolid(p + k.yxy * h, id) + k.xxx * sdSolid(p + k.xxx * h, id));
}

// ── Environment: dark studio with two softboxes ──
float softbox(vec3 d, vec3 L, float k) { return smoothstep(k - 0.012, k + 0.004, dot(d, L)); }
vec3 env(vec3 d) {
  vec3 c = mix(uSkyLow, uSkyHigh, smoothstep(-0.7, 0.8, d.y));
  c += uFloorGlow * smoothstep(0.0, -0.9, d.y);      // soft floor glow so TIR never goes black
  c += uHorizonColor * pow(max(0.0, 1.0 - abs(d.y - 0.02) * 2.6), 3.0) * 0.55;
  c += uSb0Color * softbox(d, normalize(vec3(-0.55, 0.70, 0.45)), 0.982) * uSb0I;
  c += uSb1Color * softbox(d, normalize(vec3(0.75, 0.25, -0.35)), 0.988) * uSb1I;
  c += uSb2Color * softbox(d, normalize(vec3(0.1, -0.85, 0.5)), 0.992) * uSb2I;
  return c;
}

vec3 shadeSolid(vec3 p, int id, vec3 rd) {
  vec3 n = nSolid(p);
  vec3 L = normalize(vec3(-0.45, 0.8, 0.6));
  float dif = 0.55 + 0.45 * max(dot(n, L), 0.0);
  if (id == 0) return uTextColor * (0.88 + 0.16 * dif); // the name: pure white by default, below bloom threshold so edges stay crisp
  int i = id - 1;
  vec3 l = p - uSlab[i].xyz;
  float hov = uSlab[i].w;
  if (abs(n.z) > 0.6) {
    vec2 uv = l.xy / (uSlabHalf.xy * uSlabScale * 2.0) + 0.5;
    if (n.z < 0.0) uv.x = 1.0 - uv.x;
    float col = float(i - (i / 2) * 2), row = float(i / 2);
    vec2 auv = vec2((clamp(uv.x, 0.0, 1.0) + col) * 0.5, (clamp(uv.y, 0.0, 1.0) + (1.0 - row)) * 0.5);
    vec3 tex = texture(uAtlas, auv).rgb;
    return tex * (1.15 + 0.6 * hov) + vec3(0.55, 0.45, 0.95) * 0.35 * hov;
  }
  return vec3(0.82, 0.78, 1.0) * (0.9 + 0.8 * hov) * dif;
}

// March inside the glass from p along rr until we exit or hit a solid.
vec3 marchInside(vec3 p, vec3 rr) {
  float tt = 0.02; vec3 q = p + rr * tt; int sid = -1; bool exited = false;
  float nearText = 10.0;
  for (int i = 0; i < __IM_STEPS__; i++) {
    if (i >= uISteps) break;
    float dl = -sdLiquid(q);
    int id; float ds = sdSolid(q, id);
    if (id == 0) nearText = min(nearText, ds);
    if (ds < 0.002) { sid = id; break; }
    if (dl < 0.002) { exited = true; break; }
    tt += max(min(dl, ds) * 0.9, 0.01);
    q = p + rr * tt;
    if (tt > 40.0) { exited = true; break; }
  }
  vec3 absorb = exp(-uAbsorb * tt);
  vec3 glow = uGlowColor * (1.0 - exp(-tt * 0.22));  // subsurface glow
  vec3 col;
  if (sid >= 0) {
    col = shadeSolid(q, sid, rr);
  } else {
    vec3 n2 = -nLiquid(q);
#ifdef CHEAP
    vec3 r0 = refract(rr, n2, uIor);
    vec3 r1 = r0;
    vec3 r2 = r0;
#else
    vec3 r0 = refract(rr, n2, uIor * (1.0 - uDisp));
    vec3 r1 = refract(rr, n2, uIor);
    vec3 r2 = refract(rr, n2, uIor * (1.0 + uDisp));
#endif
    vec3 rf = reflect(rr, n2);
    bool tir = dot(r1, r1) < 0.5;
    if (tir) { r0 = rf; r1 = rf; r2 = rf; }                      // total internal reflection
    if (dot(r0, r0) < 0.5) r0 = r1;
    if (dot(r2, r2) < 0.5) r2 = r1;
    col = vec3(env(r0).r, env(r1).g, env(r2).b) * 0.9;
    if (tir) col = mix(col, uTIRColor, 0.55);        // TIR reads as tinted glass, not a dark seam
    col *= mix(uHaloMin, 1.0, smoothstep(0.0, uHaloRange, nearText));       // soft dark halo hugging the letters
  }
  return col * absorb + glow;
}

// Ray vs sphere; returns entry/exit distances, false on miss.
bool raySphere(vec3 ro, vec3 rd, vec4 s, out float t0, out float t1) {
  vec3 oc = ro - s.xyz;
  float b = dot(oc, rd), c = dot(oc, oc) - s.w * s.w;
  float h = b * b - c;
  if (h < 0.0) return false;
  h = sqrt(h); t0 = -b - h; t1 = -b + h;
  return t1 > 0.0;
}

float hash12(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }

void main() {
  vec2 uv = ((gl_FragCoord.xy + uJitter) * 2.0 - uRes) / uRes.y;
  vec3 rd = normalize(uCamMat * vec3(uv * uTanFov, -1.0));
  vec3 ro = uCamPos;

  vec3 bg = env(rd) * 0.7;
  float vig = 1.0 - uVignette * dot(uv * 0.6, uv * 0.6);
  bg *= vig;

  vec3 col;
  // Distance along rd to whatever this pixel resolved to. The temporal resolve needs it
  // to turn the pixel back into a world position and look it up in the previous frame.
  // Background gets a far sentinel, which reprojects as a pure direction — correct, since
  // the environment is infinitely distant.
  float hitT = 1e4;
  // Only march inside the union of the two cluster bounding spheres; everything else is background.
  float ta0, ta1, tb0, tb1;
  bool ha = raySphere(ro, rd, uBoundA, ta0, ta1);
  bool hb = raySphere(ro, rd, uBoundB, tb0, tb1);
  float tStart = 1e9, tEnd = 0.0;
  if (ha) { tStart = min(tStart, max(ta0, 0.0)); tEnd = max(tEnd, ta1); }
  if (hb) { tStart = min(tStart, max(tb0, 0.0)); tEnd = max(tEnd, tb1); }
  if (sdLiquid(ro) < 0.0) {
    col = marchInside(ro, rd);
    hitT = 0.0;
  } else if (!ha && !hb) {
    col = bg;
  } else {
    float t = tStart; int hit = -2; vec3 p = ro;
    for (int i = 0; i < __RM_STEPS__; i++) {
      if (i >= uSteps) break;
      p = ro + rd * t;
      float dl = sdLiquid(p);
      int id; float ds = sdSolid(p, id);
      float d = min(dl, ds);
      if (d < 0.0012 * t + 0.0008) { hit = (dl <= ds) ? -1 : id; break; }
      t += d * 0.9;
      if (t > tEnd) break;
    }
    if (hit == -2) {
      col = bg;
    } else if (hit >= 0) {
      col = shadeSolid(p, hit, rd);
      hitT = t;
    } else {
      hitT = t;
      vec3 n = nLiquid(p);
      float cosi = clamp(dot(-rd, n), 0.0, 1.0);
      float F = 0.04 + 0.96 * pow(1.0 - cosi, 5.0);
      vec3 refl = env(reflect(rd, n));
      vec3 rr = refract(rd, n, 1.0 / uIor);
      vec3 refr = marchInside(p, rr);
      col = mix(refr, refl, F);
      // distance fog toward the background so far clusters fade in gracefully
      col = mix(col, bg, smoothstep(30.0, 70.0, t));
    }
  }
  col += (hash12(gl_FragCoord.xy + uTime) - 0.5) / 255.0;
  fragColor = vec4(col, hitT);
}
`;

function buildFrag({ maxb, rmSteps, imSteps, cheap }) {
  const s = FRAG_TEMPLATE
    .replace('__MAXB__', String(maxb))
    .replace('__RM_STEPS__', String(rmSteps))
    .replace('__IM_STEPS__', String(imSteps));
  return cheap ? '#define CHEAP\n' + s : s;
}

// Full quality — identical output to the pre-refactor shader.
export const FRAG = buildFrag({ maxb: 36, rmSteps: 256, imSteps: 128, cheap: false });
// Cheap placeholder: same SDF/lighting model, far smaller compile-time loop bounds and no
// chromatic dispersion, so ANGLE compiles it fast. See js/main.js for the swap logic.
export const FRAG_FAST = buildFrag({ maxb: 10, rmSteps: 48, imSteps: 24, cheap: true });
