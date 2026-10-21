// sdf-worker.js — runs the exact distance transform and half-float packing off the main thread.
import { edtSigned, toHalf } from './sdf.js?v=20261021c';
self.onmessage = e => {
  const { id, mask, w, h } = e.data;
  const t0 = performance.now();
  const half = toHalf(edtSigned(mask, w, h));
  self.postMessage({ id, half, ms: performance.now() - t0 }, [half.buffer]);
};
