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

const BOX = (s: string, q: string) =>
  `((${s}.eval(${q} + float2(-0.5,-0.5)).rgb + ${s}.eval(${q} + float2(0.5,-0.5)).rgb + ` +
  `${s}.eval(${q} + float2(-0.5,0.5)).rgb + ${s}.eval(${q} + float2(0.5,0.5)).rgb) * 0.25)`;

/** Builds a merge shader for `n` frames (2–4). Uniforms: o1..o{n-1} (float2), sigma (float). */
export function mergeSkSL(n: number): string {
  let s = '';
  for (let k = 0; k < n; k++) s += `uniform shader f${k};\n`;
  for (let k = 1; k < n; k++) s += `uniform float2 o${k};\n`;
  s += 'uniform float sigma;\n';
  s += 'half4 main(float2 p) {\n';
  s += '  float3 r = f0.eval(p).rgb;\n';
  s += `  float3 rb = ${BOX('f0', 'p')};\n`;
  s += '  float3 acc = r;\n  float w = 1.0;\n';
  for (let k = 1; k < n; k++) {
    s += '  {\n';
    s += `    float2 q = p + o${k};\n`;
    s += `    float3 c = f${k}.eval(q).rgb;\n`;
    s += `    float3 dd = ${BOX(`f${k}`, 'q')} - rb;\n`;
    s += '    float wk = exp(-dot(dd, dd) / sigma);\n';
    s += '    acc += c * wk;\n    w += wk;\n';
    s += '  }\n';
  }
  s += '  return half4(half3(acc / w), 1.0);\n}\n';
  return s;
}

/** Uniform order: gain, shadows, compress, sat, sharp, warmth */
export const TONE_SKSL = `
uniform shader img;
uniform shader base;
uniform float gain;
uniform float shadows;
uniform float compress;
uniform float sat;
uniform float sharp;
uniform float warmth;

float lum(float3 c) { return dot(c, float3(0.2126, 0.7152, 0.0722)); }
float3 toLin(float3 c) { return pow(max(c, float3(0.0)), float3(2.2)); }
float3 toGamma(float3 c) { return pow(clamp(c, 0.0, 1.0), float3(1.0 / 2.2)); }

half4 main(float2 p) {
  float3 c = img.eval(p).rgb;

  // Unsharp mask in gamma space (Pixel-like crisp micro-contrast)
  float3 nb = (img.eval(p + float2(1.5, 0.0)).rgb + img.eval(p - float2(1.5, 0.0)).rgb +
               img.eval(p + float2(0.0, 1.5)).rgb + img.eval(p - float2(0.0, 1.5)).rgb) * 0.25;
  c = c + (c - nb) * sharp;

  float3 lin = toLin(c) * gain;
  float L = lum(lin) + 0.0001;
  float Lb = lum(toLin(base.eval(p).rgb)) * gain + 0.0001;

  // Local tone mapping: compress the base layer's range around middle grey
  float lb = log2(Lb / 0.18);
  lb = lb > 0.0 ? lb * (1.0 - compress) : lb * (1.0 - compress * 0.55);
  float nB = 0.18 * exp2(lb);
  // Shadow lift (Pixel "Shadows" control), strongest in the deepest tones
  nB = max(nB + shadows * 0.05 * exp(-nB * 14.0), 0.0);

  float detail = pow(L / Lb, 1.12);
  float3 o = lin * (nB * detail / L);

  // Filmic highlight roll-off (extended Reinhard)
  o *= 1.25;
  o = o * (1.0 + o / 9.0) / (1.0 + o);

  // Vibrance: boost muted colours more than already-saturated ones
  float l = lum(o);
  float mx = max(o.r, max(o.g, o.b));
  float mn = min(o.r, min(o.g, o.b));
  float s = (mx - mn) / (mx + 0.0001);
  o = mix(float3(l), o, sat + (sat - 1.0) * 1.5 * (1.0 - s));

  // Neutral-cool balance
  o *= float3(1.0 + warmth, 1.0, 1.0 - warmth);

  float3 g = toGamma(o);
  g = mix(g, g * g * (3.0 - 2.0 * g), 0.16); // gentle S-curve
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
