import type { CamMode } from '../../modules/icamera';

export type CaptureMode = CamMode;

export type VideoSettings = {
  resolution: '4k' | '1080p';
  fps: 30 | 60;
  hdr: boolean;
  /** Anti-flicker for indoor lights: by country, camera auto, 50 Hz, 60 Hz or off */
  antibanding?: 'country' | 'auto' | '50' | '60' | 'off';
  stabilization: 'cinematic' | 'standard' | 'off' | 'horizon';
};

export type PhotoSettings = {
  frames: 1 | 2 | 3 | 4 | 5 | 6;
  /** Use the phone maker's Night extension in Night Sight when available */
  vendorNight: boolean;
  /** Add a darker bracket frame to recover bright windows / sky (backlit scenes) */
  highlightBracket: boolean;
};

/** A zoom pill. `lensId` = open that rear camera directly (a lens the main camera's zoom can't reach). */
export type Lens = { label: string; zoom: number; lensId?: string };

/** Zoom pills (Pixel style) from the camera's zoom-ratio range; < 1× means an ultra-wide lens is available. */
export function lensStops(zoomMin: number, zoomMax: number): Lens[] {
  const stops: Lens[] = [];
  // Ultrawide stop at 0.7× (or the widest the lens allows, if it can't go that wide)
  if (zoomMin < 0.95) {
    const uw = Math.max(zoomMin, 0.7);
    stops.push({ label: trim(uw), zoom: uw });
  }
  stops.push({ label: '1', zoom: 1 });
  if (zoomMax >= 2) stops.push({ label: '2', zoom: 2 });
  if (zoomMax >= 5) stops.push({ label: '5', zoom: 5 });
  return stops;
}

export function trim(n: number) {
  const s = n.toFixed(1);
  return s.endsWith('.0') ? s.slice(0, -2) : s;
}
