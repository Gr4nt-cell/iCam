/**
 * SkSL for the photo pipeline. These run on the GPU through Skia.
 *
 * 1. MERGE  – HDR+-style robust temporal merge: each aligned burst frame is averaged into the
 *             reference, weighted by how similar it is (after a small box filter) so moving
 *             subjects and misalignment are rejected instead of ghosting.
 * 2. TONE   – Pixel-style local tone mapping: a heavily blurred base layer is compressed in
 *             log space (protects highlights, lifts shadows) while local detail is kept and
 *             slightly boosted; then filmic roll-off, vibrance, cool-neutral balance, gentle
 *             S-curve and sharpening.
 */

const BOX = (sh: string, q: string) =>
  `((${sh}.eval(${q} + float2(-0.5,-0.5)).rgb + ${sh}.eval(${q} + float2(0.5,-0.5)).rgb + ` +
  `${sh}.eval(${q} + float2(-0.5,0.5)).rgb + ${sh}.eval(${q} + float2(0.5,0.5)).rgb) * 0.25)`;

/**
 * Merge shader for `n` frames (2–4), HDR+ style:
 *  - per-frame global shift (o{k}) plus a per-tile residual read from a small offset map (m{k}),
 *    so every region of the frame is aligned on its own
 *  - robust, noise-aware weighting: the tolerance grows with brightness (shot noise), so shadows
 *    average more aggressively while moving subjects are still rejected
 * Children order: f0..f{n-1}, m1..m{n-1}. Uniforms: o1..o{n-1} (float2), sigma.
 */
export function mergeSkSL(n: number): string {
  let s = '';
  for (let k = 0; k < n; k++) s += `uniform shader f${k};\n`;
  for (let k = 1; k < n; k++) s += `uniform shader m${k};\n`;
  for (let k = 1; k < n; k++) s += `uniform float2 o${k};\n`;
  s += 'uniform float sigma;\n';
  s += 'half4 main(float2 p) {\n';
  s += '  float3 r = f0.eval(p).rgb;\n';
  s += `  float3 rb = ${BOX('f0', 'p')};\n`;
  s += '  float lr = dot(rb, float3(0.299, 0.587, 0.114));\n';
  s += '  float sig = sigma * (0.3 + 1.7 * lr);\n';
  s += '  float3 acc = r;\n  float w = 1.0;\n';
  for (let k = 1; k < n; k++) {
    s += '  {\n';
    s += `    float2 res = (m${k}.eval(p).rg * 255.0 - 128.0) * 0.5;\n`;
    s += `    float2 q = p + o${k} + res;\n`;
    s += `    float3 c = f${k}.eval(q).rgb;\n`;
    s += `    float3 dd = ${BOX(`f${k}`, 'q')} - rb;\n`;
    s += '    float wk = exp(-dot(dd, dd) / sig);\n';
    s += '    acc += c * wk;\n    w += wk;\n';
    s += '  }\n';
  }
  s += '  return half4(half3(acc / w), 1.0);\n}\n';
  return s;
}

/**
 * Edge-aware denoise after merging: chroma (colour blotches) is averaged strongly across pixels of
 * similar brightness, luma only lightly, so texture and edges survive.
 * Uniform order: chroma, luma, radius
 */
export const DENOISE_SKSL = `
uniform shader img;
uniform float chroma;
uniform float luma;
uniform float radius;

half4 main(float2 p) {
  float3 W = float3(0.299, 0.587, 0.114);
  float3 c = img.eval(p).rgb;
  float y = dot(c, W);
  float3 ch = c - y;
  float3 accC = ch;
  float wc = 1.0;
  float accY = y;
  float wy = 1.0;
  for (int i = 0; i < 12; i++) {
    float fi = float(i);
    float a = fi * 0.5235988;
    float r = mod(fi, 2.0) < 0.5 ? radius : radius * 0.5;
    float3 s = img.eval(p + float2(cos(a), sin(a)) * r).rgb;
    float ys = dot(s, W);
    float dy = ys - y;
    float kc = exp(-dy * dy / 0.004);
    accC += (s - ys) * kc;
    wc += kc;
    float kl = exp(-dy * dy / 0.0012);
    accY += ys * kl;
    wy += kl;
  }
  float3 o = mix(y, accY / wy, luma) + mix(ch, accC / wc, chroma);
  return half4(half3(clamp(o, 0.0, 1.0)), 1.0);
}
`;

/**
 * Two-scale local tone mapping (Pixel-like):
 *  - coarse base (scene illumination) is compressed in log space → highlights held, shadows lifted
 *  - mid-scale "clarity" and fine detail are kept and slightly boosted
 *  - edge-aware sharpening, hue-preserving highlight roll-off, vibrance, neutral-cool balance, S-curve
 * Children: img, baseF (fine base), baseC (coarse base).
 * Uniform order: gain, shadows, compress, sat, sharp, warmth, clarity
 */
export const TONE_SKSL = `
uniform shader img;
uniform shader baseF;
uniform shader baseC;
uniform float gain;
uniform float shadows;
uniform float compress;
uniform float sat;
uniform float sharp;
uniform float warmth;
uniform float clarity;

float lum(float3 c) { return dot(c, float3(0.2126, 0.7152, 0.0722)); }
float3 toLin(float3 c) { return pow(max(c, float3(0.0)), float3(2.2)); }
float3 toGamma(float3 c) { return pow(clamp(c, 0.0, 1.0), float3(1.0 / 2.2)); }

half4 main(float2 p) {
  float3 c = img.eval(p).rgb;

  // Edge-aware unsharp mask: sharpen real edges, leave flat (noisy) areas alone
  float3 nb = (img.eval(p + float2(1.5, 0.0)).rgb + img.eval(p - float2(1.5, 0.0)).rgb +
               img.eval(p + float2(0.0, 1.5)).rgb + img.eval(p - float2(0.0, 1.5)).rgb) * 0.25;
  float3 hp = c - nb;
  float edge = smoothstep(0.008, 0.045, abs(lum(hp)) + length(hp) * 0.3);
  c = c + hp * sharp * edge;

  float3 lin = toLin(c) * gain;
  float L = lum(lin) + 0.0001;
  float Lf = lum(toLin(baseF.eval(p).rgb)) * gain + 0.0001;
  float Lc = lum(toLin(baseC.eval(p).rgb)) * gain + 0.0001;
  // Halo control: near strong edges (window frame vs face) let the base follow the pixel
  Lf = exp2(mix(log2(Lf), log2(L), smoothstep(1.2, 3.0, abs(log2(L / Lf))) * 0.6));
  Lc = exp2(mix(log2(Lc), log2(Lf), smoothstep(1.2, 3.0, abs(log2(Lf / Lc))) * 0.6));

  float lc = log2(Lc / 0.18);
  lc = lc > 0.0 ? lc * (1.0 - compress) : lc * (1.0 - compress * 0.4);
  float lm = log2(Lf / Lc) * clarity;
  float ld = log2(L / Lf) * 1.08;
  float Lo = 0.18 * exp2(lc + lm + ld);
  Lo = max(Lo + shadows * 0.05 * exp(-Lo * 14.0), 0.0);
  float3 o = lin * (Lo / L);

  // Hue-preserving filmic roll-off
  o *= 1.22;
  float lo = max(lum(o), 0.0001);
  float lt = lo * (1.0 + lo / 9.0) / (1.0 + lo);
  o *= lt / lo;
  float mx = max(o.r, max(o.g, o.b));
  if (mx > 1.0) {
    o = mix(o / mx, float3(lt), clamp((mx - 1.0) * 0.5, 0.0, 1.0) * 0.6);
  }

  // Vibrance
  float l = lum(o);
  float hi = max(o.r, max(o.g, o.b));
  float lo2 = min(o.r, min(o.g, o.b));
  float s = (hi - lo2) / (hi + 0.0001);
  o = mix(float3(l), o, sat + (sat - 1.0) * 1.5 * (1.0 - s));

  o *= float3(1.0 + warmth, 1.0, 1.0 - warmth);

  float3 g = toGamma(o);
  g = mix(g, g * g * (3.0 - 2.0 * g), 0.22);
  return half4(half3(g), 1.0);
}
`;

/**
 * Face/skin smoothing: an edge-preserving (bilateral-style) blur on a 16-tap ring,
 * applied only where pixels fall in the skin-tone range of YCbCr, so eyes, hair,
 * lips and background keep their detail.
 * Uniform order: strength, radius
 */
export const SMOOTH_SKSL = `
uniform shader img;
uniform float strength;
uniform float radius;

float skinMask(float3 c) {
  float y = dot(c, float3(0.299, 0.587, 0.114));
  float cb = 0.5 - 0.168736 * c.r - 0.331264 * c.g + 0.5 * c.b;
  float cr = 0.5 + 0.5 * c.r - 0.418688 * c.g - 0.081312 * c.b;
  return smoothstep(0.27, 0.32, cb) * (1.0 - smoothstep(0.48, 0.53, cb)) *
         smoothstep(0.50, 0.54, cr) * (1.0 - smoothstep(0.67, 0.71, cr)) *
         smoothstep(0.12, 0.22, y);
}

half4 main(float2 p) {
  float3 c = img.eval(p).rgb;
  float m = skinMask(c) * strength;
  if (m < 0.01) { return half4(half3(c), 1.0); }
  float3 acc = c;
  float w = 1.0;
  for (int i = 0; i < 16; i++) {
    float fi = float(i);
    float a = fi * 0.39269908;
    float r = mod(fi, 2.0) < 0.5 ? radius : radius * 0.5;
    float3 s = img.eval(p + float2(cos(a), sin(a)) * r).rgb;
    float3 d = s - c;
    float wk = exp(-dot(d, d) / 0.010);
    acc += s * wk;
    w += wk;
  }
  float3 o = mix(c, acc / w, m);
  o = mix(o, o * 1.03 + 0.008, 0.5 * m); // a touch of glow on skin
  return half4(half3(clamp(o, 0.0, 1.0)), 1.0);
}
`;

/** Uniform order: sat, contrast, warmth, fade, mono, vignette, size(float2) */
export const FILTER_SKSL = `
uniform shader img;
uniform float sat;
uniform float contrast;
uniform float warmth;
uniform float fade;
uniform float mono;
uniform float vignette;
uniform float2 size;

half4 main(float2 p) {
  float3 c = img.eval(p).rgb;
  float l = dot(c, float3(0.2126, 0.7152, 0.0722));
  c = mix(float3(l), c, sat);
  c = mix(c, float3(l), mono);
  c *= float3(1.0 + warmth, 1.0 + warmth * 0.2, 1.0 - warmth);
  c = (c - 0.5) * contrast + 0.5;
  c = c * (1.0 - fade) + fade;
  float2 uv = p / size - 0.5;
  c *= 1.0 - vignette * smoothstep(0.3, 0.85, length(uv) * 1.3);
  return half4(half3(clamp(c, 0.0, 1.0)), 1.0);
}
`;

/**
 * Highlight recovery: where the merged frame is near clipping, blend in the darker bracket frame
 * (scaled up by its exposure difference) so windows, sky and lamps keep detail.
 * Output is linear * 0.5 re-encoded, giving one stop of headroom for the tone mapper.
 * Children: merged, short, map (alignment residuals). Uniforms: offset(float2), boost
 */
export const FUSE_SKSL = `
uniform shader merged;
uniform shader shortF;
uniform shader map;
uniform float2 offset;
uniform float boost;

float3 toLin(float3 c) { return pow(max(c, float3(0.0)), float3(2.2)); }

half4 main(float2 p) {
  float3 m = merged.eval(p).rgb;
  float2 res = (map.eval(p).rg * 255.0 - 128.0) * 0.5;
  float3 s = shortF.eval(p + offset + res).rgb;
  float3 ml = toLin(m);
  float3 sl = toLin(s) * boost;
  float hi = max(m.r, max(m.g, m.b));
  float w = smoothstep(0.72, 0.97, hi);
  // don't pull in the short frame where it disagrees strongly (motion)
  float lm = dot(ml, float3(0.2126, 0.7152, 0.0722));
  float ls = dot(sl, float3(0.2126, 0.7152, 0.0722));
  w *= (ls > lm * 0.6) ? 1.0 : 0.3;
  float3 o = mix(ml, sl, w) * 0.5;
  return half4(half3(pow(clamp(o, 0.0, 1.0), float3(1.0 / 2.2))), 1.0);
}
`;

/** Auto levels: black point, white point and a touch of midtone contrast (removes haze). Uniforms: black, white */
export const LEVELS_SKSL = `
uniform shader img;
uniform float black;
uniform float white;

half4 main(float2 p) {
  float3 c = img.eval(p).rgb;
  c = (c - black) / max(white - black, 0.2);
  return half4(half3(clamp(c, 0.0, 1.0)), 1.0);
}
`;
