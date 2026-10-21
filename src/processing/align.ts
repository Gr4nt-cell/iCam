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
