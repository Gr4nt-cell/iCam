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
import { estimateShift, type LumaPlane } from './align';
import { readExifOrientation } from './exif';
import { mergeSkSL, TONE_SKSL } from './shaders';

/** Long edge we process at (≈12.5 MP at 4:3) – keeps GPU memory and time bounded. */
const MAX_EDGE = 4096;

export type ProcessOptions = {
  night: boolean;
  /** Pixel "Brightness" slider, -1…1 */
  brightness: number;
  /** Pixel "Shadows" slider, -1…1 */
  shadows: number;
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

/** Coarse-to-fine global alignment of each frame to frames[0]. Offsets are in full-res pixels. */
function align(frames: SkImage[]): [number, number][] {
  const W = frames[0].width();
  const refC = lumaPlane(frames[0], 64);
  const refF = lumaPlane(frames[0], 256);
  const out: [number, number][] = [];
  for (let k = 1; k < frames.length; k++) {
    if (!refC || !refF) {
      out.push([0, 0]);
      continue;
    }
    const cC = lumaPlane(frames[k], 64);
    const cF = lumaPlane(frames[k], 256);
    if (!cC || !cF) {
      out.push([0, 0]);
      continue;
    }
    const [cx, cy] = estimateShift(refC, cC, 4);
    const [fx, fy] = estimateShift(refF, cF, 2, cx * 4, cy * 4);
    const scale = W / 256;
    out.push([fx * scale, fy * scale]);
  }
  return out;
}

function merge(frames: SkImage[], offsets: [number, number][], sigma: number): SkImage {
  const n = frames.length;
  const fx = effect(`merge${n}`, mergeSkSL(n));
  const children = frames.map((f) =>
    f.makeShaderOptions(TileMode.Clamp, TileMode.Clamp, FilterMode.Linear, MipmapMode.None),
  );
  const uniforms: number[] = [];
  offsets.forEach(([x, y]) => uniforms.push(x, y));
  uniforms.push(sigma);

  const W = frames[0].width();
  const H = frames[0].height();
  const surf = surface(W, H);
  const paint = Skia.Paint();
  paint.setShader(fx.makeShaderWithChildren(uniforms, children));
  surf.getCanvas().drawPaint(paint);
  return snapshot(surf);
}

function toneMap(img: SkImage, opts: ProcessOptions): SkImage {
  const W = img.width();
  const H = img.height();

  // Base layer for local tone mapping: 1/16 scale, blurred, bilinearly upsampled in the shader
  const f = 16;
  const bw = Math.max(4, Math.round(W / f));
  const bh = Math.max(4, Math.round(H / f));
  const base = resized(img, bw, bh, 4);

  // Auto exposure from the log-average luminance (the burst is shot underexposed)
  const px = rgba(base);
  let logSum = 0;
  let count = 0;
  if (px) {
    for (let j = 0; j < px.length; j += 4) {
      const r = Math.pow(px[j] / 255, 2.2);
      const g = Math.pow(px[j + 1] / 255, 2.2);
      const b = Math.pow(px[j + 2] / 255, 2.2);
      logSum += Math.log(0.0005 + 0.2126 * r + 0.7152 * g + 0.0722 * b);
      count++;
    }
  }
  const logAvg = count ? Math.exp(logSum / count) : 0.18;
  const key = opts.night ? 0.11 : 0.14;
  const maxGain = opts.night ? 8 : 3;
  const gain = Math.min(maxGain, Math.max(0.8, key / logAvg)) * Math.pow(2, opts.brightness * 0.7);

  const params = opts.night
    ? { shadows: 0.9, compress: 0.45, sat: 1.1, sharp: 0.2, warmth: -0.01 }
    : { shadows: 0.6, compress: 0.35, sat: 1.08, sharp: 0.35, warmth: -0.015 };
  const shadows = params.shadows + opts.shadows * 0.6;

  const fx = effect('tone', TONE_SKSL);
  const m = Skia.Matrix();
  m.scale(W / bw, H / bh);
  const children = [
    img.makeShaderOptions(TileMode.Clamp, TileMode.Clamp, FilterMode.Linear, MipmapMode.None),
    base.makeShaderOptions(TileMode.Clamp, TileMode.Clamp, FilterMode.Linear, MipmapMode.None, m),
  ];
  const shader = fx.makeShaderWithChildren(
    [gain, shadows, params.compress, params.sat, params.sharp, params.warmth],
    children,
  );
  const surf = surface(W, H);
  const paint = Skia.Paint();
  paint.setShader(shader);
  surf.getCanvas().drawPaint(paint);
  return snapshot(surf);
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
    const offsets = align(usable);
    await yieldFrame();
    merged = merge(usable, offsets, opts.night ? 0.015 : 0.006);
  }
  await yieldFrame();
  const out = toneMap(merged, opts);
  const bytes = out.encodeToBytes(ImageFormat.JPEG, 94);

  const file = new File(Paths.cache, `iCam_${Date.now()}.jpg`);
  file.create({ overwrite: true });
  file.write(bytes);
  return { uri: file.uri, frames: usable.length, width: W, height: H };
}
