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
  { key: 'mono', label: 'Mono', sat: 1, contrast: 1.08, warmth: 0, fade: 0, mono: 1, vignette: 0.1, preview: 'grayscale(1) contrast(1.08)' },
];

export const filterByKey = (k: FilterKey) => FILTERS.find((f) => f.key === k) ?? FILTERS[0];
