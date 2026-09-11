// sdf.js — build a signed distance field texture from text drawn with the page's fonts.
// Uses the Felzenszwalb–Huttenlocher exact Euclidean distance transform (two 1-D passes).

const INF = 1e20;

function edt1d(f, d, v, z, n) {
  v[0] = 0; z[0] = -INF; z[1] = INF;
  let k = 0;
  for (let q = 1; q < n; q++) {
    let s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    while (s <= z[k]) {
      k--;
      s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    }
    k++; v[k] = q; z[k] = s; z[k + 1] = INF;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++;
    d[q] = (q - v[k]) * (q - v[k]) + f[v[k]];
  }
}

// grid: Float32Array of 0 (seed) / INF; replaced in place by squared distances to nearest seed.
function edt(grid, w, h) {
  const n = Math.max(w, h);
  const f = new Float32Array(n), d = new Float32Array(n), v = new Int32Array(n), z = new Float32Array(n + 1);
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) f[y] = grid[y * w + x];
    edt1d(f, d, v, z, h);
    for (let y = 0; y < h; y++) grid[y * w + x] = d[y];
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) f[x] = grid[y * w + x];
    edt1d(f, d, v, z, w);
    for (let x = 0; x < w; x++) grid[y * w + x] = d[x];
  }
}

/**
 * Rasterise `lines` centred on a w×h canvas and return a Float32Array signed distance
 * (positive outside) normalised by canvas width, so world distance = value * worldWidth.
 */
export function textSDF(lines, { w = 1024, h = 512, font = 'Syne', weight = 800, fill = 0.86, lineHeight = 0.92, spacing = -0.03 } = {}) {
  const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#000'; ctx.fillRect(0, 0, w, h);

  // Pick the largest font size where every line fits horizontally and the block fits vertically.
  let fs = h / (lines.length * lineHeight) * fill;
  ctx.font = `${weight} ${fs}px ${font}, sans-serif`;
  ctx.letterSpacing = `${spacing * fs}px`;
  const widest = Math.max(...lines.map(l => ctx.measureText(l).width));
  if (widest > w * fill) { fs *= (w * fill) / widest; ctx.font = `${weight} ${fs}px ${font}, sans-serif`; ctx.letterSpacing = `${spacing * fs}px`; }

  ctx.fillStyle = '#fff'; ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
  const lh = fs * lineHeight;
  const capH = fs * 0.72;                              // Syne cap height ≈ 0.72em
  const blockH = (lines.length - 1) * lh + capH;
  const y0 = h / 2 - blockH / 2 + capH;
  lines.forEach((line, i) => ctx.fillText(line, w / 2 + (spacing * fs) / 2, y0 + i * lh));

  const img = ctx.getImageData(0, 0, w, h).data;
  const inside = new Float32Array(w * h), outside = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const on = img[i * 4] > 127;
    inside[i] = on ? 0 : INF;     // distance to nearest inside pixel (for outside points)
    outside[i] = on ? INF : 0;    // distance to nearest outside pixel (for inside points)
  }
  edt(inside, w, h); edt(outside, w, h);
  const sdf = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const d = img[i * 4] > 127 ? -Math.sqrt(outside[i]) : Math.sqrt(inside[i]);
    sdf[i] = (d - 0.5) / w;      // half-pixel shift so the zero crossing sits on the glyph edge
  }
  return { data: sdf, w, h, aspect: w / h };
}
