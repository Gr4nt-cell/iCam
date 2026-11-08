/** Photo and Portrait share one face treatment, independent of the selected camera. */
export const DEFAULT_PHOTO_SMOOTHING = 0.45;

export function restorePhotoSmoothing(saved?: number, legacy?: number): number {
  if (typeof saved === 'number' && Number.isFinite(saved)) return Math.max(0, Math.min(1, saved));
  if (typeof legacy === 'number' && Number.isFinite(legacy) && legacy > 0) return Math.min(1, legacy);
  return DEFAULT_PHOTO_SMOOTHING;
}

export function captureSmoothing(mode: string, photo: number, other: number): number {
  return mode === 'photo' || mode === 'portrait' ? photo : other;
}
