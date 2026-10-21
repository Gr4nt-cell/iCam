export type LumaPlane = { data: Float32Array; w: number; h: number };

/**
 * Brute-force translation search (sum of absolute differences) of `cur` against `ref`,
 * centred on (cx, cy) with ±radius. Returns the offset to sample `cur` at so it lines up with `ref`.
 * Used coarse-to-fine like HDR+'s tile alignment, but global (hand-shake is mostly translation).
 */
export function estimateShift(
  ref: LumaPlane,
  cur: LumaPlane,
  radius: number,
  cx = 0,
  cy = 0,
): [number, number] {
  const { w, h } = ref;
  const margin = radius + Math.max(Math.abs(cx), Math.abs(cy)) + 1;
  if (margin * 2 >= Math.min(w, h)) return [cx, cy];

  let best = Infinity;
  let bx = cx;
  let by = cy;
  const step = w > 128 ? 2 : 1; // subsample rows/cols on the fine level for speed
  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      const sx = cx + dx;
      const sy = cy + dy;
      let sad = 0;
      let n = 0;
      for (let y = margin; y < h - margin; y += step) {
        const rRow = y * w;
        const cRow = (y + sy) * w + sx;
        for (let x = margin; x < w - margin; x += step) {
          sad += Math.abs(ref.data[rRow + x] - cur.data[cRow + x]);
          n++;
        }
      }
      const score = sad / Math.max(1, n);
      if (score < best) {
        best = score;
        bx = sx;
        by = sy;
      }
    }
  }
  return [bx, by];
}

/**
 * Per-tile refinement around a global shift (cx, cy): splits the frame into gw × gh tiles and finds
 * each tile's own best offset within ±radius. Flat tiles (too little texture to align) keep the
 * global shift. Returns residuals relative to (cx, cy), row-major.
 */
export function tileResiduals(
  ref: LumaPlane,
  cur: LumaPlane,
  cx: number,
  cy: number,
  gw: number,
  gh: number,
  radius: number,
): { dx: Int8Array; dy: Int8Array } {
  const { w, h } = ref;
  const dx = new Int8Array(gw * gh);
  const dy = new Int8Array(gw * gh);
  const margin = radius + Math.max(Math.abs(cx), Math.abs(cy)) + 1;
  for (let ty = 0; ty < gh; ty++) {
    for (let tx = 0; tx < gw; tx++) {
      const x0 = Math.max(margin, Math.floor((tx * w) / gw));
      const x1 = Math.min(w - margin, Math.floor(((tx + 1) * w) / gw));
      const y0 = Math.max(margin, Math.floor((ty * h) / gh));
      const y1 = Math.min(h - margin, Math.floor(((ty + 1) * h) / gh));
      if (x1 - x0 < 4 || y1 - y0 < 4) continue;

      // Skip tiles without enough texture to align reliably
      let mean = 0;
      let n = 0;
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { mean += ref.data[y * w + x]; n++; }
      mean /= n;
      let varSum = 0;
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { const d = ref.data[y * w + x] - mean; varSum += d * d; }
      if (varSum / n < 0.0004) continue;

      let best = Infinity;
      let bx = 0;
      let by = 0;
      for (let ry = -radius; ry <= radius; ry++) {
        for (let rx = -radius; rx <= radius; rx++) {
          const sx = cx + rx;
          const sy = cy + ry;
          let sad = 0;
          for (let y = y0; y < y1; y++) {
            const rr = y * w;
            const cr = (y + sy) * w + sx;
            for (let x = x0; x < x1; x++) sad += Math.abs(ref.data[rr + x] - cur.data[cr + x]);
          }
          // tiny bias toward zero residual for stability
          sad += (Math.abs(rx) + Math.abs(ry)) * 0.002 * n;
          if (sad < best) { best = sad; bx = rx; by = ry; }
        }
      }
      dx[ty * gw + tx] = bx;
      dy[ty * gw + tx] = by;
    }
  }
  return { dx, dy };
}
