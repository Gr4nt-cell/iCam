import type {
  CameraDevice,
  CameraDeviceFormat,
  FormatFilter,
  VideoStabilizationMode,
} from 'react-native-vision-camera';

export type CaptureMode = 'night' | 'photo' | 'video' | 'action';

export type VideoSettings = {
  resolution: '4k' | '1080p';
  fps: 30 | 60;
  hevc: boolean;
  hdr: boolean;
  stabilization: 'cinematic' | 'standard' | 'off';
};

export type PhotoSettings = {
  frames: 1 | 2 | 3 | 4;
  nativeHdr: boolean;
};

export type Lens = { label: string; zoom: number };

/** Zoom stops shown as Pixel-style pills, derived from the physical lenses the device reports. */
export function lensStops(device?: CameraDevice): Lens[] {
  if (!device) return [];
  const neutral = device.neutralZoom || 1;
  const maxRel = device.maxZoom / neutral;
  const stops: Lens[] = [];
  const lenses = device.physicalDevices;

  if (lenses.includes('ultra-wide-angle-camera') && device.minZoom < neutral * 0.95) {
    stops.push({ label: trim(device.minZoom / neutral), zoom: device.minZoom });
  }
  stops.push({ label: '1', zoom: neutral });
  if (maxRel >= 2) stops.push({ label: '2', zoom: neutral * 2 });
  if (lenses.includes('telephoto-camera')) {
    if (maxRel >= 5) stops.push({ label: '5', zoom: neutral * 5 });
    else if (maxRel >= 3) stops.push({ label: '3', zoom: neutral * 3 });
  }
  return stops;
}

export function displayZoom(device: CameraDevice | undefined, zoom: number) {
  if (!device) return '1';
  return trim(zoom / (device.neutralZoom || 1));
}

function trim(n: number) {
  const s = n.toFixed(1);
  return s.endsWith('.0') ? s.slice(0, -2) : s;
}

const STAB_PREFERENCE: Record<VideoSettings['stabilization'], VideoStabilizationMode[]> = {
  cinematic: ['cinematic-extended', 'cinematic', 'standard', 'auto'],
  standard: ['standard', 'auto'],
  off: ['off'],
};

/** Best stabilization the chosen format actually supports, in order of preference. */
export function pickStabilization(
  format: CameraDeviceFormat | undefined,
  wanted: VideoSettings['stabilization'],
): VideoStabilizationMode | undefined {
  if (!format) return undefined;
  const supported = format.videoStabilizationModes ?? [];
  return STAB_PREFERENCE[wanted].find((m) => supported.includes(m));
}

/**
 * Format filters, highest priority first.
 * Photo modes target the sensor's ~12 MP binned output (fast readout, better SNR, like Pixel),
 * video targets the requested resolution / frame rate / stabilization / HDR.
 */
export function formatFilters(mode: CaptureMode, video: VideoSettings): FormatFilter[] {
  if (mode === 'photo' || mode === 'night') {
    return [
      { photoAspectRatio: 4 / 3 },
      { photoResolution: { width: 4032, height: 3024 } },
      { videoAspectRatio: 4 / 3 },
      { videoResolution: { width: 1920, height: 1440 } },
    ];
  }
  if (mode === 'action') {
    return [
      { videoResolution: { width: 1920, height: 1080 } },
      { fps: 60 },
      { videoStabilizationMode: 'cinematic-extended' },
    ];
  }
  const filters: FormatFilter[] = [
    {
      videoResolution:
        video.resolution === '4k' ? { width: 3840, height: 2160 } : { width: 1920, height: 1080 },
    },
    { fps: video.fps },
  ];
  if (video.stabilization !== 'off') {
    filters.push({
      videoStabilizationMode: video.stabilization === 'cinematic' ? 'cinematic-extended' : 'standard',
    });
  }
  if (video.hdr) filters.push({ videoHdr: true });
  return filters;
}

export type DeviceProfile = {
  id: string;
  name: string;
  position: string;
  lenses: string;
  hardwareLevel: string;
  sensorOrientation: string;
  maxPhotoMp: number;
  maxVideo: string;
  maxFps: number;
  videoHdr: boolean;
  photoHdr: boolean;
  stabilization: string;
  lowLightBoost: boolean;
  flash: boolean;
  focus: boolean;
  zoomRange: string;
  exposureRange: string;
  formats: number;
};

/** Human-readable summary of each camera the phone exposes. */
export function profileDevice(d: CameraDevice): DeviceProfile {
  let maxPhoto = 0;
  let maxVideoPx = 0;
  let maxVideo = '—';
  let maxFps = 0;
  const stab = new Set<string>();
  for (const f of d.formats) {
    maxPhoto = Math.max(maxPhoto, f.photoWidth * f.photoHeight);
    const vpx = f.videoWidth * f.videoHeight;
    if (vpx > maxVideoPx) {
      maxVideoPx = vpx;
      maxVideo = `${f.videoWidth}×${f.videoHeight}`;
    }
    maxFps = Math.max(maxFps, f.maxFps);
    f.videoStabilizationModes?.forEach((m) => stab.add(m));
  }
  const n = d.neutralZoom || 1;
  return {
    id: d.id,
    name: d.name,
    position: d.position,
    lenses: d.physicalDevices.map((p) => p.replace('-camera', '').replace(/-/g, ' ')).join(', '),
    hardwareLevel: d.hardwareLevel,
    sensorOrientation: d.sensorOrientation,
    maxPhotoMp: Math.round(maxPhoto / 1e5) / 10,
    maxVideo,
    maxFps,
    videoHdr: d.formats.some((f) => f.supportsVideoHdr),
    photoHdr: d.formats.some((f) => f.supportsPhotoHdr),
    stabilization: [...stab].join(', ') || 'none',
    lowLightBoost: d.supportsLowLightBoost,
    flash: d.hasFlash,
    focus: d.supportsFocus,
    zoomRange: `${(d.minZoom / n).toFixed(1)}× – ${(d.maxZoom / n).toFixed(0)}×`,
    exposureRange: `${d.minExposure.toFixed(1)} … ${d.maxExposure.toFixed(1)} EV`,
    formats: d.formats.length,
  };
}
