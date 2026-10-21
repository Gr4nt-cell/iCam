export type FilterKey = 'natural' | 'vivid' | 'warm' | 'cool' | 'film' | 'dramatic' | 'mono' | 'noir';

export type FilterPreset = {
  key: FilterKey;
  label: string;
  sat: number;
  contrast: number;
  warmth: number;
  fade: number;
  mono: number;
  vignette: number;
  /** CSS-style filter for the live viewfinder (Android 12+ renders it on the preview) */
  preview?: string;
};

export const FILTERS: FilterPreset[] = [
  { key: 'natural', label: 'Natural', sat: 1, contrast: 1, warmth: 0, fade: 0, mono: 0, vignette: 0 },
  { key: 'vivid', label: 'Vivid', sat: 1.3, contrast: 1.08, warmth: 0, fade: 0, mono: 0, vignette: 0.1, preview: 'saturate(1.3) contrast(1.08)' },
  { key: 'warm', label: 'Warm', sat: 1.05, contrast: 1.02, warmth: 0.06, fade: 0, mono: 0, vignette: 0.1, preview: 'sepia(0.18) saturate(1.12)' },
  { key: 'cool', label: 'Cool', sat: 1.0, contrast: 1.03, warmth: -0.06, fade: 0, mono: 0, vignette: 0.1, preview: 'hue-rotate(-10deg) saturate(1.05)' },
  { key: 'film', label: 'Film', sat: 0.88, contrast: 0.94, warmth: 0.02, fade: 0.05, mono: 0, vignette: 0.25, preview: 'saturate(0.88) contrast(0.94) sepia(0.08)' },
  { key: 'dramatic', label: 'Dramatic', sat: 0.85, contrast: 1.25, warmth: 0, fade: 0, mono: 0, vignette: 0.3, preview: 'contrast(1.25) saturate(0.85)' },
  { key: 'mono', label: 'Mono', sat: 1, contrast: 1.08, warmth: 0, fade: 0, mono: 1, vignette: 0.1, preview: 'grayscale(1) contrast(1.08)' },
  { key: 'noir', label: 'Noir', sat: 1, contrast: 1.4, warmth: 0, fade: 0, mono: 1, vignette: 0.4, preview: 'grayscale(1) contrast(1.4)' },
];

export const filterByKey = (k: FilterKey) => FILTERS.find((f) => f.key === k) ?? FILTERS[0];
