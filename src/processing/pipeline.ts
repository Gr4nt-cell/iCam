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
import { estimateShift, tileResiduals, type LumaPlane } from './align';
import { readExifOrientation } from './exif';
import { filterByKey, type FilterKey } from './filters';
import { DENOISE_SKSL, FILTER_SKSL, mergeSkSL, SMOOTH_SKSL, TONE_SKSL } from './shaders';

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
export async function loadUpright(path: string): Promise<SkImage> {
  const uri = path.startsWith('file://') ? path : `file://${path}`;
  const bytes = await new File(uri).bytes();
  const orientation = readExifOrientation(bytes);
  const img = Skia.Image.MakeImageFromEncoded(Skia.Data.fromBytes(bytes));
  if (!img) throw new Error('Could not decode photo');

  const w = img.width();
  const h = img.height();
  const swap = orientation >= 5;
  const s = Math.min(1, MAX_EDGE / Math.max(w, h));
  const ow = Math.round((swap ? h : w) * s);
  const oh = Math.round((swap ? w : h) * s);

  const surf = surface(ow, oh);
  const c = surf.getCanvas();
  c.save();
  c.scale(s, s);
  applyOrientation(c, orientation, w, h);
  c.drawImageRectOptions(
    img,
    Skia.XYWHRect(0, 0, w, h),
    Skia.XYWHRect(0, 0, w, h),
    FilterMode.Linear,
    MipmapMode.None,
  );
  c.restore();
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

/** Encodes per-tile residuals (full-res px, 0.5 px steps) into a tiny RGBA image the merge shader samples. */
function offsetMap(dx: Int8Array, dy: Int8Array, gw: number, gh: number, scale: number): SkImage {
  const px = new Uint8Array(gw * gh * 4);
  for (let i = 0; i < gw * gh; i++) {
    px[i * 4] = Math.max(0, Math.min(255, Math.round(128 + dx[i] * scale * 2)));
    px[i * 4 + 1] = Math.max(0, Math.min(255, Math.round(128 + dy[i] * scale * 2)));
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

/**
 * HDR+-style alignment of each frame to frames[0]: coarse global search (64 px), refined global
 * shift (256 px), then per-tile residuals on an 8 × n grid so local motion / slight rotation aligns too.
 */
function align(frames: SkImage[]): Alignment[] {
  const W = frames[0].width();
  const refC = lumaPlane(frames[0], 64);
  const refF = lumaPlane(frames[0], 256);
  const gh = Math.max(4, Math.round((GRID_W * frames[0].height()) / W));
  const scale = W / 256;
  const zero = new Int8Array(GRID_W * gh);
  const out: Alignment[] = [];
  for (let k = 1; k < frames.length; k++) {
    const cC = refC && lumaPlane(frames[k], 64);
    const cF = refF && lumaPlane(frames[k], 256);
    if (!refC || !refF || !cC || !cF) {
      out.push({ global: [0, 0], map: offsetMap(zero, zero, GRID_W, gh, scale) });
      continue;
    }
    const [cx, cy] = estimateShift(refC, cC, 4);
    const [fx, fy] = estimateShift(refF, cF, 2, cx * 4, cy * 4);
    const { dx, dy } = tileResiduals(refF, cF, fx, fy, GRID_W, gh, 2);
    out.push({ global: [fx * scale, fy * scale], map: offsetMap(dx, dy, GRID_W, gh, scale) });
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
  const maxGain = opts.night ? 8 : 3;
  const gain = Math.min(maxGain, Math.max(0.8, key / logAvg)) * Math.pow(2, opts.brightness * 0.7);

  // High-contrast scenes (lots of bright sky / windows) get more range compression
  const params = opts.night
    ? { shadows: 0.9, compress: 0.45, sat: 1.1, sharp: 0.25, warmth: -0.01, clarity: 1.08 }
    : { shadows: 0.6, compress: 0.32 + Math.min(0.15, brightShare * 0.6), sat: 1.08, sharp: 0.45, warmth: -0.015, clarity: 1.15 };
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
export async function processSingle(path: string, smoothing: number, filter: FilterKey): Promise<string> {
  const img = finishLook(await loadUpright(path), smoothing, filter);
  const file = new File(Paths.cache, `iCam_${Date.now()}.jpg`);
  file.create({ overwrite: true });
  file.write(img.encodeToBytes(ImageFormat.JPEG, 95));
  return file.uri;
}

/**
 * Full HDR+-style pipeline: decode → upright → align → robust merge → local tone map → JPEG.
 * Writes the result to the app cache and returns its file URI.
 */
export async function processBurst(paths: string[], opts: ProcessOptions): Promise<ProcessResult> {
  const frames: SkImage[] = [];
  for (const p of paths) {
    frames.push(await loadUpright(p));
    await yieldFrame();
  }
  const W = frames[0].width();
  const H = frames[0].height();
  const usable = frames.filter((f) => f.width() === W && f.height() === H).slice(0, 4);

  let merged = usable[0];
  if (usable.length > 1) {
    const al = align(usable);
    await yieldFrame();
    merged = merge(usable, al, opts.night ? 0.012 : 0.005);
  }
  await yieldFrame();
  // Clean remaining noise before tone mapping lifts the shadows (stronger with fewer frames / at night)
  const radius = Math.max(3, Math.min(W, H) / 500);
  const fewFrames = usable.length < 3 ? 0.15 : 0;
  merged = shade(merged, 'denoise', DENOISE_SKSL, [
    opts.night ? 0.95 : 0.8,
    (opts.night ? 0.35 : 0.12) + fewFrames,
    radius,
  ]);
  await yieldFrame();
  let out = toneMap(merged, opts);
  await yieldFrame();
  out = finishLook(out, opts.smoothing ?? 0, opts.filter ?? 'natural');
  const bytes = out.encodeToBytes(ImageFormat.JPEG, 94);

  const file = new File(Paths.cache, `iCam_${Date.now()}.jpg`);
  file.create({ overwrite: true });
  file.write(bytes);
  return { uri: file.uri, frames: usable.length, width: W, height: H };
}
