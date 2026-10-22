import {
  AlphaType,
  ColorType,
  FilterMode,
  ImageFormat,
  MipmapMode,
  Skia,
  TileMode,
  type SkCanvas,
  type SkImage,
  type SkRuntimeEffect,
  type SkSurface,
} from '@shopify/react-native-skia';
import { File, Paths } from 'expo-file-system';
import { estimateNoise, estimateShift, refineSubpixel, tileResiduals, type LumaPlane } from './align';
import { filterByKey, type FilterKey } from './filters';
import {
  BG_PREP_SKSL,
  DENOISE_SKSL,
  FILTER_SKSL,
  FUSE_SKSL,
  LEVELS_SKSL,
  mergeSkSL,
  PORTRAIT_SKSL,
  SMOOTH_SKSL,
  TONE_SKSL,
} from './shaders';

/** Long edge we process at (≈12.5 MP at 4:3) – keeps GPU memory and time bounded. */
const MAX_EDGE = 4096;

export type ProcessOptions = {
  night: boolean;
  /** Pixel "Brightness" slider, -1…1 */
  brightness: number;
  /** Pixel "Shadows" slider, -1…1 */
  shadows: number;
  /** Face smoothing strength 0…1 (0 = off) */
  smoothing?: number;
  filter?: FilterKey;
  /** Index of the darker bracket frame in `paths` (-1 = none) and the EV each frame was shot at */
  shortIndex?: number;
  evs?: number[];
  /** Detected faces (normalized boxes on the upright photo) for face-priority exposure */
  faces?: { x: number; y: number; w: number; h: number }[];
  /** Per-frame EXIF info from the camera (orientation / stored size) */
  meta?: PhotoMeta[];
  /** Output width/height ratio in portrait (3/4, 9/16, 1, or the screen's) */
  aspect?: number;
  /** Portrait mode: person mask (grayscale PNG on the upright photo) and blur strength 0..1 */
  portrait?: { maskPath: string; strength: number };
};

export type ProcessResult = { uri: string; frames: number; width: number; height: number };

const effectCache = new Map<string, SkRuntimeEffect>();
function effect(key: string, src: string): SkRuntimeEffect {
  let e = effectCache.get(key);
  if (!e) {
    const made = Skia.RuntimeEffect.Make(src);
    if (!made) throw new Error(`Shader ${key} failed to compile`);
    e = made;
    effectCache.set(key, e);
  }
  return e;
}

function surface(w: number, h: number): SkSurface {
  const s = Skia.Surface.MakeOffscreen(w, h) ?? Skia.Surface.Make(w, h);
  if (!s) throw new Error('Could not allocate surface');
  return s;
}

function snapshot(s: SkSurface): SkImage {
  s.flush();
  return s.makeImageSnapshot();
}

const yieldFrame = () => new Promise<void>((r) => setTimeout(r, 0));

/** Applies an EXIF orientation (1–8) for an image of size w×h drawn at the origin. */
function applyOrientation(c: SkCanvas, o: number, w: number, h: number) {
  switch (o) {
    case 2: c.translate(w, 0); c.scale(-1, 1); break;
    case 3: c.translate(w, h); c.rotate(180, 0, 0); break;
    case 4: c.translate(0, h); c.scale(1, -1); break;
    case 5: c.translate(h, 0); c.scale(-1, 1); c.translate(h, 0); c.rotate(90, 0, 0); break;
    case 6: c.translate(h, 0); c.rotate(90, 0, 0); break;
    case 7: c.translate(0, w); c.scale(1, -1); c.translate(h, 0); c.rotate(90, 0, 0); break;
    case 8: c.translate(0, w); c.rotate(270, 0, 0); break;
    default: break;
  }
}

/** Decodes a JPEG, bakes in its EXIF rotation and scales it to ≤ MAX_EDGE. */
export type PhotoMeta = {
  orientation: number;
  width: number;
  height: number;
  /** Front camera: 1 = the phone already mirrored the JPEG, 0 = true view, -1 = unknown */
  jpegMirrored?: number;
};

/** Learned at runtime: does Skia's decoder already apply EXIF orientation? (null = not known yet) */
let skiaAppliesExif: boolean | null = null;

/**
 * Decodes a JPEG, makes it upright (rotation + selfie mirroring from EXIF) and scales to ≤ MAX_EDGE.
 * Whether the decoder already rotated is detected from the image size, so this is correct either way.
 */
export async function loadUpright(path: string, meta?: PhotoMeta): Promise<SkImage> {
  const uri = path.startsWith('file://') ? path : `file://${path}`;
  const bytes = await new File(uri).bytes();
  const img = Skia.Image.MakeImageFromEncoded(Skia.Data.fromBytes(bytes));
  if (!img) throw new Error('Could not decode photo');

  const w = img.width();
  const h = img.height();
  const o = meta?.orientation ?? 1;
  if (meta && o >= 5 && o <= 8 && meta.width !== meta.height && meta.width > 0) {
    skiaAppliesExif = w === meta.height && h === meta.width;
  }
  const apply = o > 1 && o <= 8 && skiaAppliesExif !== true;
  const swap = apply && o >= 5;

  const s = Math.min(1, MAX_EDGE / Math.max(w, h));
  const ow = Math.round((swap ? h : w) * s);
  const oh = Math.round((swap ? w : h) * s);
  const surf = surface(ow, oh);
  const c = surf.getCanvas();
  c.save();
  c.scale(s, s);
  if (apply) applyOrientation(c, o, w, h);
  c.drawImageRectOptions(img, Skia.XYWHRect(0, 0, w, h), Skia.XYWHRect(0, 0, w, h), FilterMode.Linear, MipmapMode.None);
  c.restore();
  return snapshot(surf);
}

/** Centre-crops to a width/height ratio (e.g. 1 for square, 9/16 for 16:9 portrait). */
export function cropToAspect(img: SkImage, ratio?: number): SkImage {
  if (!ratio) return img;
  const W = img.width();
  const H = img.height();
  // keep the photo's own orientation (portrait/landscape)
  const r = W > H ? 1 / ratio : ratio;
  let cw = W;
  let ch = Math.round(W / r);
  if (ch > H) {
    ch = H;
    cw = Math.round(H * r);
  }
  if (Math.abs(cw - W) < 4 && Math.abs(ch - H) < 4) return img;
  const surf = surface(cw, ch);
  surf.getCanvas().drawImageRectOptions(
    img,
    Skia.XYWHRect((W - cw) / 2, (H - ch) / 2, cw, ch),
    Skia.XYWHRect(0, 0, cw, ch),
    FilterMode.Linear,
    MipmapMode.None,
  );
  return snapshot(surf);
}

function resized(img: SkImage, tw: number, th: number, blurSigma = 0): SkImage {
  const surf = surface(tw, th);
  const paint = Skia.Paint();
  if (blurSigma > 0) {
    paint.setImageFilter(Skia.ImageFilter.MakeBlur(blurSigma, blurSigma, TileMode.Clamp, null));
  }
  surf
    .getCanvas()
    .drawImageRectOptions(
      img,
      Skia.XYWHRect(0, 0, img.width(), img.height()),
      Skia.XYWHRect(0, 0, tw, th),
      FilterMode.Linear,
      MipmapMode.None,
      paint,
    );
  return snapshot(surf);
}

function rgba(img: SkImage): Uint8Array | null {
  const px = img.readPixels(0, 0, {
    width: img.width(),
    height: img.height(),
    colorType: ColorType.RGBA_8888,
    alphaType: AlphaType.Unpremul,
  });
  return px instanceof Uint8Array ? px : null;
}

function lumaPlane(img: SkImage, tw: number): LumaPlane | null {
  const th = Math.max(8, Math.round((img.height() * tw) / img.width()));
  const px = rgba(resized(img, tw, th));
  if (!px) return null;
  const data = new Float32Array(tw * th);
  for (let i = 0, j = 0; i < data.length; i++, j += 4) {
    data[i] = (0.2126 * px[j] + 0.7152 * px[j + 1] + 0.0722 * px[j + 2]) / 255;
  }
  return { data, w: tw, h: th };
}

type Alignment = { global: [number, number]; map: SkImage };

const GRID_W = 8;
/** Offset-map encoding: 1 unit = 1/MAP_RES px (must match the shaders' decode) */
const MAP_RES = 4;
/** Finest alignment level width; ≈ 1/4 of a 12 MP frame */
const FINE_W = 1024;

/** Encodes per-tile residuals (full-res px) into a tiny RGBA image the merge shader samples. */
function offsetMap(dx: Float32Array, dy: Float32Array, gw: number, gh: number): SkImage {
  const px = new Uint8Array(gw * gh * 4);
  for (let i = 0; i < gw * gh; i++) {
    px[i * 4] = Math.max(0, Math.min(255, Math.round(128 + dx[i] * MAP_RES)));
    px[i * 4 + 1] = Math.max(0, Math.min(255, Math.round(128 + dy[i] * MAP_RES)));
    px[i * 4 + 2] = 128;
    px[i * 4 + 3] = 255;
  }
  const img = Skia.Image.MakeImage(
    { width: gw, height: gh, colorType: ColorType.RGBA_8888, alphaType: AlphaType.Unpremul },
    Skia.Data.fromBytes(px),
    gw * 4,
  );
  if (!img) throw new Error('Could not build alignment map');
  return img;
}

/** Last measured per-frame noise (σ at full resolution, 0..1) — drives merge and denoise strength. */
let lastNoise = 0.012;

/**
 * Pixel HDR+-style pyramid alignment of each frame to frames[0]:
 *   64 px (±4) → 256 px (±2) → 1024 px (±2) global search, sub-pixel parabola refinement,
 *   then per-tile residuals on the 1024 px level so local motion / slight rotation aligns too.
 * Precision ≈ 1 px at full resolution (was ~16 px with the old 256 px top level).
 */
/** Scale `cur` to the same mean brightness as `ref` (needed to align a darker bracket frame). */
function matchMean(ref: LumaPlane, cur: LumaPlane): LumaPlane {
  let a = 0;
  let b = 0;
  for (let i = 0; i < ref.data.length; i += 7) { a += ref.data[i]; b += cur.data[i]; }
  if (b <= 0) return cur;
  const k = a / b;
  if (Math.abs(k - 1) < 0.15) return cur;
  const data = new Float32Array(cur.data.length);
  for (let i = 0; i < data.length; i++) data[i] = Math.min(1, cur.data[i] * k);
  return { data, w: cur.w, h: cur.h };
}

function align(frames: SkImage[]): Alignment[] {
  const W = frames[0].width();
  const fineW = Math.min(FINE_W, W);
  const refC = lumaPlane(frames[0], 64);
  const refM = lumaPlane(frames[0], 256);
  const refF = lumaPlane(frames[0], fineW);
  const gh = Math.max(4, Math.round((GRID_W * frames[0].height()) / W));
  const scale = W / fineW;
  const zero = new Float32Array(GRID_W * gh);
  const out: Alignment[] = [];
  const noises: number[] = [];
  for (let k = 1; k < frames.length; k++) {
    const rawC = refC && lumaPlane(frames[k], 64);
    const rawM = refM && lumaPlane(frames[k], 256);
    const rawF = refF && lumaPlane(frames[k], fineW);
    const cC = refC && rawC ? matchMean(refC, rawC) : null;
    const cM = refM && rawM ? matchMean(refM, rawM) : null;
    const cF = refF && rawF ? matchMean(refF, rawF) : null;
    if (!refC || !refM || !refF || !cC || !cM || !cF) {
      out.push({ global: [0, 0], map: offsetMap(zero, zero, GRID_W, gh) });
      continue;
    }
    const [cx, cy] = estimateShift(refC, cC, 4);
    const [mx, my] = estimateShift(refM, cM, 2, cx * 4, cy * 4);
    const fr = fineW / 256;
    const [fx, fy] = estimateShift(refF, cF, 2, Math.round(mx * fr), Math.round(my * fr));
    const [sx, sy] = refineSubpixel(refF, cF, fx, fy);
    noises.push(estimateNoise(refF, cF, sx, sy));
    const t = tileResiduals(refF, cF, fx, fy, GRID_W, gh, 2);
    const dx = new Float32Array(t.dx.length);
    const dy = new Float32Array(t.dy.length);
    // residual relative to the sub-pixel global shift, in full-res px
    for (let i = 0; i < dx.length; i++) {
      dx[i] = t.dx[i] === 0 && t.dy[i] === 0 ? 0 : (fx + t.dx[i] - sx) * scale;
      dy[i] = t.dx[i] === 0 && t.dy[i] === 0 ? 0 : (fy + t.dy[i] - sy) * scale;
    }
    out.push({ global: [sx * scale, sy * scale], map: offsetMap(dx, dy, GRID_W, gh) });
  }
  if (noises.length) {
    noises.sort((a, b) => a - b);
    // the 1024 px level averages ~scale² pixels, so full-res σ is ~scale× larger
    lastNoise = Math.max(0.004, Math.min(0.08, noises[Math.floor(noises.length / 2)] * scale));
  }
  return out;
}

function merge(frames: SkImage[], al: Alignment[], sigma: number): SkImage {
  const n = frames.length;
  const fx = effect(`merge${n}`, mergeSkSL(n));
  const W = frames[0].width();
  const H = frames[0].height();
  const clampLinear = (img: SkImage, m?: ReturnType<typeof Skia.Matrix>) =>
    img.makeShaderOptions(TileMode.Clamp, TileMode.Clamp, FilterMode.Linear, MipmapMode.None, m);
  const children = frames.map((f) => clampLinear(f));
  al.forEach((a) => {
    const m = Skia.Matrix();
    m.scale(W / a.map.width(), H / a.map.height());
    children.push(clampLinear(a.map, m));
  });
  const uniforms: number[] = [];
  al.forEach((a) => uniforms.push(a.global[0], a.global[1]));
  uniforms.push(sigma);

  const surf = surface(W, H);
  const paint = Skia.Paint();
  paint.setShader(fx.makeShaderWithChildren(uniforms, children));
  surf.getCanvas().drawPaint(paint);
  return snapshot(surf);
}

function toneMap(img: SkImage, opts: ProcessOptions): SkImage {
  const W = img.width();
  const H = img.height();

  // Two illumination layers for local tone mapping: fine (1/16) and coarse (1/64)
  const fw = Math.max(4, Math.round(W / 16));
  const fh = Math.max(4, Math.round(H / 16));
  const baseF = resized(img, fw, fh, 3);
  const cw = Math.max(2, Math.round(W / 64));
  const chh = Math.max(2, Math.round(H / 64));
  const baseC = resized(baseF, cw, chh, 2.5);

  // Auto exposure from the log-average luminance (the burst is shot under-exposed)
  const px = rgba(baseF);
  let logSum = 0;
  let count = 0;
  let hiCount = 0;
  if (px) {
    for (let j = 0; j < px.length; j += 4) {
      const r = Math.pow(px[j] / 255, 2.2);
      const g = Math.pow(px[j + 1] / 255, 2.2);
      const b = Math.pow(px[j + 2] / 255, 2.2);
      const l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      logSum += Math.log(0.0005 + l);
      if (l > 0.6) hiCount++;
      count++;
    }
  }
  const logAvg = count ? Math.exp(logSum / count) : 0.18;
  const brightShare = count ? hiCount / count : 0;
  const key = opts.night ? 0.11 : 0.145;
  const maxGain = opts.night ? 10 : 6;
  let gain = Math.min(maxGain, Math.max(0.6, key / logAvg));

  // Face-priority exposure: expose people properly even against a bright background
  let faceBoost = 0;
  if (px && opts.faces?.length) {
    let fs = 0;
    let fn = 0;
    for (const f of opts.faces) {
      const x0 = Math.floor(f.x * fw);
      const x1 = Math.ceil((f.x + f.w) * fw);
      const y0 = Math.floor(f.y * fh);
      const y1 = Math.ceil((f.y + f.h) * fh);
      for (let y = Math.max(0, y0); y < Math.min(fh, y1); y++) {
        for (let x = Math.max(0, x0); x < Math.min(fw, x1); x++) {
          const j = (y * fw + x) * 4;
          fs += 0.2126 * Math.pow(px[j] / 255, 2.2) + 0.7152 * Math.pow(px[j + 1] / 255, 2.2) + 0.0722 * Math.pow(px[j + 2] / 255, 2.2);
          fn++;
        }
      }
    }
    if (fn > 0) {
      const faceL = fs / fn;
      const faceGain = Math.min(maxGain, 0.2 / Math.max(faceL, 0.002));
      if (faceGain > gain) {
        faceBoost = Math.log2(faceGain / gain);
        gain = gain * Math.pow(faceGain / gain, 0.85);
      }
    }
  }
  gain *= Math.pow(2, opts.brightness * 0.7);

  // Backlit / high-contrast scenes get more range compression so the background isn't blown
  const contrastyScene = Math.min(0.2, brightShare * 0.6) + Math.min(0.2, faceBoost * 0.1);
  const params = opts.night
    ? { shadows: 0.6, compress: 0.45, sat: 1.1, sharp: 0.25, warmth: -0.01, clarity: 1.08 }
    : { shadows: 0.3, compress: 0.3 + contrastyScene, sat: 1.1, sharp: 0.55, warmth: -0.015, clarity: 1.2 };
  const shadows = params.shadows + opts.shadows * 0.6;

  const fx = effect('tone2', TONE_SKSL);
  const mF = Skia.Matrix();
  mF.scale(W / fw, H / fh);
  const mC = Skia.Matrix();
  mC.scale(W / cw, H / chh);
  const children = [
    img.makeShaderOptions(TileMode.Clamp, TileMode.Clamp, FilterMode.Linear, MipmapMode.None),
    baseF.makeShaderOptions(TileMode.Clamp, TileMode.Clamp, FilterMode.Linear, MipmapMode.None, mF),
    baseC.makeShaderOptions(TileMode.Clamp, TileMode.Clamp, FilterMode.Linear, MipmapMode.None, mC),
  ];
  const shader = fx.makeShaderWithChildren(
    [gain, shadows, params.compress, params.sat, params.sharp, params.warmth, params.clarity],
    children,
  );
  const surf = surface(W, H);
  const paint = Skia.Paint();
  paint.setShader(shader);
  surf.getCanvas().drawPaint(paint);
  return snapshot(surf);
}

function shade(img: SkImage, key: string, src: string, uniforms: number[]): SkImage {
  const fx = effect(key, src);
  const child = img.makeShaderOptions(TileMode.Clamp, TileMode.Clamp, FilterMode.Linear, MipmapMode.None);
  const surf = surface(img.width(), img.height());
  const paint = Skia.Paint();
  paint.setShader(fx.makeShaderWithChildren(uniforms, [child]));
  surf.getCanvas().drawPaint(paint);
  return snapshot(surf);
}

/** Skin smoothing + colour filter, applied after tone mapping. */
export function finishLook(img: SkImage, smoothing = 0, filter: FilterKey = 'natural'): SkImage {
  let out = img;
  if (smoothing > 0.01) {
    const radius = Math.max(3, Math.min(img.width(), img.height()) / 380);
    out = shade(out, 'smooth', SMOOTH_SKSL, [smoothing, radius]);
  }
  const f = filterByKey(filter);
  if (f.key !== 'natural') {
    out = shade(out, 'filter', FILTER_SKSL, [
      f.sat, f.contrast, f.warmth, f.fade, f.mono, f.vignette, out.width(), out.height(),
    ]);
  }
  return out;
}

/** Applies smoothing/filter to an already-processed photo file (used for Pro-mode shots). */
export type SingleOptions = {
  smoothing: number;
  filter: FilterKey;
  aspect?: number;
  meta?: PhotoMeta;
  portrait?: { maskPath: string; strength: number };
  /** Flip left↔right (selfie mirroring) */
  mirror?: boolean;
  /** Detail/clarity strength: 1 = full (plain camera frame), ~0.4 when the phone already processed it, 0 = off */
  enhance?: number;
  /** Zoom past the lens maximum: centre crop + upscale + detail reconstruction */
  digitalZoom?: number;
};

/**
 * Digital zoom: centre crop, high-quality bicubic (Catmull-Rom) upscale back to full size, then
 * edge-aware detail reconstruction at the scale the detail was lost, plus extra grain control.
 */
function zoomCrop(img: SkImage, dz: number): SkImage {
  const W = img.width();
  const H = img.height();
  const cw = W / dz;
  const ch = H / dz;
  const surf = surface(W, H);
  surf
    .getCanvas()
    .drawImageRectCubic(img, Skia.XYWHRect((W - cw) / 2, (H - ch) / 2, cw, ch), Skia.XYWHRect(0, 0, W, H), 0, 0.5);
  let out = snapshot(surf);
  const px = Math.min(3, Math.max(1, dz * 0.35));
  // clean upscaled noise first, then rebuild edges at the right scale
  out = shade(out, 'denoise', DENOISE_SKSL, [0.9, Math.min(0.5, 0.15 + dz * 0.01), Math.max(3, px * 2), 0.002]);
  out = enhance(out, dz > 10 ? 1.5 : 0.9, px);
  return out;
}

/** Mirrors an image left↔right. */
export function flipH(img: SkImage): SkImage {
  const surf = surface(img.width(), img.height());
  const c = surf.getCanvas();
  c.translate(img.width(), 0);
  c.scale(-1, 1);
  c.drawImage(img, 0, 0);
  return snapshot(surf);
}

/**
 * Single-frame finishing: noise-aware detail sharpening (fine texture without amplifying grain),
 * mid-tone clarity (local contrast) and gentle vibrance.
 */
function enhance(img: SkImage, amount: number, radius?: number): SkImage {
  if (amount <= 0.01) return img;
  const W = img.width();
  const H = img.height();
  // low-frequency base for clarity, brought back to full size
  const small = resized(img, Math.max(8, Math.round(W / 8)), Math.max(8, Math.round(H / 8)), 2);
  const base = resized(small, W, H);
  const fx = effect('enhance', ENHANCE_SKSL);
  const opt = (i: SkImage) => i.makeShaderOptions(TileMode.Clamp, TileMode.Clamp, FilterMode.Linear, MipmapMode.None);
  const surf = surface(W, H);
  const paint = Skia.Paint();
  const k = Math.min(1.5, amount);
  // Vibrance stays strong even when the phone already processed the photo (matches the video look)
  paint.setShader(fx.makeShaderWithChildren([0.7 * k, 0.28 * k, 0.45, radius ?? Math.max(1, Math.min(W, H) / 2000)], [opt(img), opt(base)]));
  surf.getCanvas().drawPaint(paint);
  return snapshot(surf);
}

const ENHANCE_SKSL = `
uniform shader img;
uniform shader base;
uniform float sharp;
uniform float clarity;
uniform float vib;
uniform float px;
float lum(float3 c) { return dot(c, float3(0.299, 0.587, 0.114)); }
half4 main(float2 p) {
  float3 c = float3(img.eval(p).rgb);
  float3 n1 = (float3(img.eval(p + float2(px, 0.0)).rgb) + float3(img.eval(p - float2(px, 0.0)).rgb) +
               float3(img.eval(p + float2(0.0, px)).rgb) + float3(img.eval(p - float2(0.0, px)).rgb)) * 0.25;
  float3 n2 = (float3(img.eval(p + float2(px, px)).rgb) + float3(img.eval(p - float2(px, px)).rgb) +
               float3(img.eval(p + float2(px, -px)).rgb) + float3(img.eval(p - float2(px, -px)).rgb)) * 0.25;
  float ly = lum(c);
  float d = ly - lum(n1 * 0.6 + n2 * 0.4);
  // coring: ignore tiny differences (sensor grain), sharpen real edges/texture
  float ad = abs(d);
  float cored = sign(d) * max(ad - 0.006, 0.0) * smoothstep(0.0, 0.03, ad);
  cored = clamp(cored, -0.08, 0.08);
  float3 o = c + cored * sharp * 1.6;
  float lb = lum(float3(base.eval(p).rgb));
  float mid = 1.0 - abs(ly * 2.0 - 1.0);
  o += (ly - lb) * clarity * mid;
  // gentle S-curve for punch (mid-tones untouched at 0.5)
  float3 sc = o * o * (3.0 - 2.0 * o);
  o = mix(o, sc, 0.18);
  // vibrance: boosts muted colours most, protects already-saturated ones and skin
  float l2 = lum(o);
  float sat = max(max(o.r, o.g), o.b) - min(min(o.r, o.g), o.b);
  o = mix(float3(l2), o, 1.0 + vib * (1.0 - sat));
  return half4(half3(clamp(o, 0.0, 1.0)), 1.0);
}
`;

export async function processSingle(path: string, o: SingleOptions): Promise<string> {
  let img = await loadUpright(path, o.meta);
  if (o.enhance) {
    await yieldFrame();
    try {
      img = enhance(img, o.enhance);
    } catch {
      // keep the unenhanced photo rather than failing (and losing mirroring etc.)
    }
  }
  if (o.portrait) img = await applyPortrait(img, o.portrait.maskPath, o.portrait.strength);
  img = finishLook(img, o.smoothing, o.filter);
  if (o.digitalZoom && o.digitalZoom > 1.01) {
    await yieldFrame();
    try {
      img = zoomCrop(img, o.digitalZoom);
    } catch {
      // keep the un-zoomed photo rather than failing
    }
  }
  if (o.mirror) img = flipH(img);
  img = cropToAspect(img, o.aspect);
  const file = new File(Paths.cache, `iCam_${Date.now()}.jpg`);
  file.create({ overwrite: true });
  file.write(img.encodeToBytes(ImageFormat.JPEG, 97));
  return file.uri;
}

/**
 * Full HDR+-style pipeline: decode → upright → align → robust merge → local tone map → JPEG.
 * Writes the result to the app cache and returns its file URI.
 */
/**
 * Portrait background blur: masked (no colour bleed) lens-style blur of the background,
 * then the sharp subject composited back with a feathered edge.
 */
export async function applyPortrait(img: SkImage, maskPath: string, strength: number): Promise<SkImage> {
  const W = img.width();
  const H = img.height();
  const uri = maskPath.startsWith('file://') ? maskPath : `file://${maskPath}`;
  const rawMask = Skia.Image.MakeImageFromEncoded(Skia.Data.fromBytes(await new File(uri).bytes()));
  if (!rawMask) return img;

  // Feather the mask a little so hair / shoulders blend naturally
  const mw = rawMask.width();
  const mh = rawMask.height();
  const mask = resized(rawMask, mw, mh, Math.max(1, mw / 300));
  const mm = Skia.Matrix();
  mm.scale(W / mw, H / mh);
  const lin = (i: SkImage, m?: ReturnType<typeof Skia.Matrix>) =>
    i.makeShaderOptions(TileMode.Clamp, TileMode.Clamp, FilterMode.Linear, MipmapMode.None, m);

  // Background only (premultiplied), at quarter resolution, then a strong blur
  const q = 4;
  const bw = Math.max(8, Math.round(W / q));
  const bh = Math.max(8, Math.round(H / q));
  const prep = effect('bgprep', BG_PREP_SKSL);
  const ps = surface(bw, bh);
  const pp = Skia.Paint();
  const toQuarter = Skia.Matrix();
  toQuarter.scale(1 / q, 1 / q);
  pp.setShader(prep.makeShaderWithChildren([], [lin(img), lin(mask, mm)], toQuarter));
  ps.getCanvas().drawPaint(pp);
  const bg = snapshot(ps);
  const sigma = (Math.min(bw, bh) / 55) * (0.35 + strength * 1.1);
  const blurred = resized(bg, bw, bh, sigma);

  const bm = Skia.Matrix();
  bm.scale(W / bw, H / bh);
  const fx = effect('portrait', PORTRAIT_SKSL);
  const surf = surface(W, H);
  const paint = Skia.Paint();
  paint.setShader(fx.makeShaderWithChildren([], [lin(img), lin(blurred, bm), lin(mask, mm)]));
  surf.getCanvas().drawPaint(paint);
  return snapshot(surf);
}

/** Auto levels from a small preview of the result: sets black/white points to remove haze. */
function autoLevels(img: SkImage): SkImage {
  const W = img.width();
  const H = img.height();
  const tw = 160;
  const th = Math.max(8, Math.round((H * tw) / W));
  const px = rgba(resized(img, tw, th));
  if (!px) return img;
  const hist = new Uint32Array(256);
  for (let j = 0; j < px.length; j += 4) {
    hist[Math.round(0.299 * px[j] + 0.587 * px[j + 1] + 0.114 * px[j + 2])]++;
  }
  const total = tw * th;
  let acc = 0;
  let lo = 0;
  for (let i = 0; i < 256; i++) { acc += hist[i]; if (acc >= total * 0.004) { lo = i; break; } }
  acc = 0;
  let hi = 255;
  for (let i = 255; i >= 0; i--) { acc += hist[i]; if (acc >= total * 0.002) { hi = i; break; } }
  const black = Math.min(0.08, Math.max(0, lo / 255 - 0.01));
  const white = Math.max(0.88, Math.min(1, hi / 255 + 0.01));
  if (black < 0.005 && white > 0.995) return img;
  return shade(img, 'levels', LEVELS_SKSL, [black, white]);
}

export async function processBurst(paths: string[], opts: ProcessOptions): Promise<ProcessResult> {
  const frames: SkImage[] = [];
  for (let i = 0; i < paths.length; i++) {
    frames.push(await loadUpright(paths[i], opts.meta?.[i]));
    await yieldFrame();
  }
  const W = frames[0].width();
  const H = frames[0].height();
  const si = opts.shortIndex ?? -1;
  const shortFrame = si >= 0 && frames[si]?.width() === W && frames[si]?.height() === H ? frames[si] : null;
  const usable = frames.filter((f, i) => i !== si && f.width() === W && f.height() === H).slice(0, 6);

  let merged = usable[0];
  if (usable.length > 1) {
    const al = align(usable);
    await yieldFrame();
    // σ² for box-filtered (×4 averaged) differences of two frames, with headroom for slight misalignment
    merged = merge(usable, al, Math.max(0.0006, 6 * lastNoise * lastNoise) * (opts.night ? 1.6 : 1));
  }
  await yieldFrame();

  // Highlight recovery from the darker bracket frame (gives the tone mapper one stop of headroom)
  if (shortFrame && opts.evs && opts.evs.length > si) {
    const evBase = opts.evs[0];
    const evShort = opts.evs[si];
    const boost = Math.pow(2, Math.max(0.5, evBase - evShort));
    const keepNoise = lastNoise;
    const [al] = align([merged, shortFrame]);
    lastNoise = keepNoise;
    const fx = effect('fuse', FUSE_SKSL);
    const m = Skia.Matrix();
    m.scale(W / al.map.width(), H / al.map.height());
    const lin = (img: SkImage, mat?: ReturnType<typeof Skia.Matrix>) =>
      img.makeShaderOptions(TileMode.Clamp, TileMode.Clamp, FilterMode.Linear, MipmapMode.None, mat);
    const surf = surface(W, H);
    const paint = Skia.Paint();
    paint.setShader(fx.makeShaderWithChildren([al.global[0], al.global[1], boost], [lin(merged), lin(shortFrame), lin(al.map, m)]));
    surf.getCanvas().drawPaint(paint);
    merged = snapshot(surf);
    await yieldFrame();
  }

  // Clean remaining noise before tone mapping lifts the shadows (stronger with fewer frames / at night)
  const radius = Math.max(3, Math.min(W, H) / 500);
  // Residual noise after merging N frames ≈ σ/√N; denoise only as much as is left
  const residual = lastNoise / Math.sqrt(Math.max(1, usable.length));
  const lumaStrength = Math.min(0.6, Math.max(0.04, residual * 20)) + (opts.night ? 0.1 : 0);
  merged = shade(merged, 'denoise', DENOISE_SKSL, [
    opts.night ? 0.95 : 0.85,
    lumaStrength,
    radius,
    Math.max(0.0004, 9 * residual * residual),
  ]);
  await yieldFrame();
  let out = toneMap(merged, opts);
  await yieldFrame();
  out = autoLevels(out);
  if (opts.portrait) {
    await yieldFrame();
    out = await applyPortrait(out, opts.portrait.maskPath, opts.portrait.strength);
  }
  out = finishLook(out, opts.smoothing ?? 0, opts.filter ?? 'natural');
  out = cropToAspect(out, opts.aspect);
  const bytes = out.encodeToBytes(ImageFormat.JPEG, 97);

  const file = new File(Paths.cache, `iCam_${Date.now()}.jpg`);
  file.create({ overwrite: true });
  file.write(bytes);
  return { uri: file.uri, frames: usable.length + (shortFrame ? 1 : 0), width: W, height: H };
}
