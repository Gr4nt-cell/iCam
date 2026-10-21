import type { CamMode } from '../../modules/icamera';

export type CaptureMode = CamMode;

export type VideoSettings = {
  resolution: '4k' | '1080p';
  fps: 30 | 60;
  hdr: boolean;
  stabilization: 'cinematic' | 'standard' | 'off';
};

export type PhotoSettings = {
  frames: 1 | 2 | 3 | 4;
  /** Use the phone maker's Night extension in Night Sight when available */
  vendorNight: boolean;
};

export type Lens = { label: string; zoom: number };

/** Zoom pills (Pixel style) from the camera's zoom-ratio range; < 1× means an ultra-wide lens is available. */
export function lensStops(zoomMin: number, zoomMax: number): Lens[] {
  const stops: Lens[] = [];
  if (zoomMin < 0.95) stops.push({ label: trim(zoomMin), zoom: zoomMin });
  stops.push({ label: '1', zoom: 1 });
  if (zoomMax >= 2) stops.push({ label: '2', zoom: 2 });
  if (zoomMax >= 5) stops.push({ label: '5', zoom: 5 });
  return stops;
}

export function trim(n: number) {
  const s = n.toFixed(1);
  return s.endsWith('.0') ? s.slice(0, -2) : s;
}
