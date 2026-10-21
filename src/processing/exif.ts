/** Reads the EXIF orientation tag (1–8) from JPEG bytes. Returns 1 when absent. */
export function readExifOrientation(b: Uint8Array): number {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return 1;
  let i = 2;
  while (i + 10 < b.length) {
    if (b[i] !== 0xff) return 1;
    const marker = b[i + 1];
    const len = (b[i + 2] << 8) | b[i + 3];
    if (marker === 0xda) return 1; // start of scan: no more metadata
    if (
      marker === 0xe1 &&
      b[i + 4] === 0x45 && // E
      b[i + 5] === 0x78 && // x
      b[i + 6] === 0x69 && // i
      b[i + 7] === 0x66 // f
    ) {
      const t = i + 10; // TIFF header
      const le = b[t] === 0x49;
      const r16 = (o: number) => (le ? b[o] | (b[o + 1] << 8) : (b[o] << 8) | b[o + 1]);
      const r32 = (o: number) =>
        (le
          ? b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)
          : (b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
      const ifd = t + r32(t + 4);
      if (ifd + 2 > b.length) return 1;
      const count = r16(ifd);
      for (let k = 0; k < count; k++) {
        const e = ifd + 2 + k * 12;
        if (e + 10 > b.length) break;
        if (r16(e) === 0x0112) {
          const v = r16(e + 8);
          return v >= 1 && v <= 8 ? v : 1;
        }
      }
      return 1;
    }
    i += 2 + len;
  }
  return 1;
}
