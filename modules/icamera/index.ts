import { requireNativeView, requireOptionalNativeModule } from 'expo';
import React, { forwardRef } from 'react';
import type { ViewProps } from 'react-native';

export type CamMode = 'photo' | 'portrait' | 'night' | 'pro' | 'macro' | 'video' | 'pvideo' | 'slowmo' | 'dual' | 'action';
export type WhiteBalance = 'auto' | 'daylight' | 'cloudy' | 'shade' | 'tungsten' | 'fluorescent' | 'twilight' | 'kelvin';

export type CameraProfile = {
  id: string;
  position: 'back' | 'front' | 'external';
  hardwareLevel: string;
  physicalCameras: number;
  focalLengths: number[];
  maxPhotoMp: number;
  videoQualities: string[];
  videoHdr: boolean;
  maxFps: number;
  zoomMin: number;
  zoomMax: number;
  evMin: number;
  evMax: number;
  flash: boolean;
  previewStabilization: boolean;
  videoStabilization: boolean;
  slowMotion: boolean;
  nightExtension: boolean;
  manualSensor: boolean;
  manualWhiteBalance: boolean;
  raw: boolean;
  isoMin: number;
  isoMax: number;
  exposureMinNs: number;
  exposureMaxNs: number;
  minFocusDistance: number;
  sensorOrientation: number;
};

export type RearLens = {
  id: string;
  /** Logical multi-camera this lens belongs to ('' = standalone camera) */
  parentId: string;
  kind: 'ultrawide' | 'main' | 'telephoto' | 'periscope telephoto' | 'macro' | 'depth';
  focalEq: number;
  /** Zoom relative to the main lens (e.g. 0.6, 1, 3) */
  ratio: number;
  mp: number;
  minFocusCm: number;
  /** Can be opened directly by an app */
  selectable: boolean;
};

export type Capabilities = {
  concurrent: boolean;
  slowMotion: boolean;
  manualSensor: boolean;
  manualWhiteBalance: boolean;
  nightExtension: boolean;
  isoMin: number;
  isoMax: number;
  exposureMinNs: number;
  exposureMaxNs: number;
  minFocusDistance: number;
  cameras: CameraProfile[];
  /** Whether this phone is strong enough for live Portrait video blur */
  portraitVideo: boolean;
  /** Rear telephoto lens detected from lens data */
  telephoto?: boolean;
  /** Telephoto reach vs the main lens (e.g. 3, 5) */
  telephotoRatio?: number;
  /** Highest zoom offered (optical + digital), from the lens data */
  maxZoom?: number;
  /** Every rear lens found (standalone cameras + lenses inside a multi-camera), widest first */
  rearLenses?: RearLens[];
  /** Macro: dedicated macro camera or close-focusing telephoto */
  macro?: boolean;
  macroKind?: 'tele' | 'dedicated';
  macroMinFocusCm?: number;

};

type NativeEvent<T> = { nativeEvent: T };

export type ReadyEvent = {
  mode: CamMode;
  slowMotionFps: number;
  nightExtension: boolean;
  /** Phone-maker processing active for this mode (absent when none) */
  extension?: 'hdr' | 'auto' | 'bokeh' | 'night';
  zoomMin: number;
  zoomMax: number;
  hasFlash: boolean;
  horizonLock?: boolean;
};

export type ICameraProps = ViewProps & {
  mode: CamMode;
  facing: 'back' | 'front';
  dualPrimary?: 'back' | 'front';
  zoom?: number;
  evBias?: number;
  /** 0 = auto. Manual exposure engages (Pro only) when both iso and shutterNs are > 0. */
  iso?: number;
  shutterNs?: number;
  whiteBalance?: WhiteBalance;
  kelvin?: number;
  /** Diopters; -1 = autofocus, 0 = infinity */
  focusDistance?: number;
  flash?: 'off' | 'auto' | 'on';
  torch?: boolean;
  mirror?: boolean;
  audio?: boolean;
  active?: boolean;
  videoQuality?: 'uhd' | 'fhd';
  fps?: number;
  hdrVideo?: boolean;
  stabilization?: 'off' | 'standard' | 'cinematic' | 'horizon';
  /** Skin smoothing 0..1 for video (photos are smoothed when processed) */
  faceSmoothing?: number;
  /** Live filter [sat, contrast, warmth, fade, mono, vignette] */
  filterParams?: number[];
  nightExtension?: boolean;
  /** Dual mode: centre (0..1, y down) and width share of the small window */
  dualPip?: { x: number; y: number; size: number };
  /** Sensor output shape for photo modes */
  aspect?: '4:3' | '16:9';
  /** Letterbox the preview (what you see = what you get) instead of filling the screen */
  previewFit?: boolean;
  /** Portrait video background blur strength 0..1 */
  bokeh?: number;
  onPortraitStatus?: (e: NativeEvent<{ blur: boolean; reason?: string }>) => void;
  onRecordingState?: (e: NativeEvent<{ paused: boolean }>) => void;
  onGesture?: (e: NativeEvent<{ kind: 'palm' | 'status'; status?: string }>) => void;
  palmShutter?: boolean;
  shutterSound?: boolean;
  /** Open this rear camera id directly (null = the default rear camera) */
  lensId?: string | null;

  onReady?: (e: NativeEvent<ReadyEvent>) => void;
  onError?: (e: NativeEvent<{ message: string }>) => void;
  onRecordingFinished?: (
    e: NativeEvent<{ path: string | null; durationMs: number; slowMotion: boolean; error: string | null }>,
  ) => void;
  onPhotosCaptured?: (
    e: NativeEvent<{
      paths: string[];
      evs?: number[];
      meta?: { orientation: number; width: number; height: number; jpegMirrored?: number }[];
      shortIndex?: number;
      error?: string;
      nightExtension: boolean;
    }>,
  ) => void;
};

export type ICameraHandle = {
  capture: (count: number, evShift: number, shortEv: number) => Promise<void>;
  startRecording: () => Promise<void>;
  stopRecording: () => Promise<void>;
  pauseRecording: () => Promise<void>;
  resumeRecording: () => Promise<void>;
  focus: (x: number, y: number) => Promise<void>;
  movePip: (x: number, y: number) => Promise<void>;
};

const NativeModule = requireOptionalNativeModule<{
  getCapabilities: () => Promise<Capabilities>;
  takeLastCrash: () => string | null;
  detectFaces: (path: string) => Promise<FaceBox[]>;
  segmentPerson: (path: string) => Promise<PersonMask | null>;
  openMedia: (id: string, isVideo: boolean, chooser: boolean) => Promise<void>;
  aiUpscale: (path: string, maxEdge: number) => Promise<AiUpscaleResult | null>;
  aiAvailable: () => boolean;
  getCaptureRequest: () => 'image' | 'video' | null;
  finishCapture: (path: string, isVideo: boolean) => Promise<boolean>;
  cancelCapture: () => Promise<boolean>;
}>('ICamera');

/** Set when another app opened iCam to take a photo or video for it ("default camera" use). */
export function getCaptureRequest(): 'image' | 'video' | null {
  try {
    return NativeModule?.getCaptureRequest() ?? null;
  } catch {
    return null;
  }
}

/** Returns the photo/video to the app that asked for it (iCam then closes). */
export async function finishCapture(path: string, isVideo: boolean): Promise<boolean> {
  try {
    return !!(await NativeModule?.finishCapture(path, isVideo));
  } catch {
    return false;
  }
}

export async function cancelCapture(): Promise<void> {
  try {
    await NativeModule?.cancelCapture();
  } catch {}
}

export type AiUpscaleResult = { path: string; width: number; height: number; ms: number };

/** Whether this build carries the on-device AI zoom model. */
export function aiAvailable(): boolean {
  try {
    return !!NativeModule?.aiAvailable();
  } catch {
    return false;
  }
}

/** On-device AI 4× super-resolution of an image file (null if unavailable or it failed). */
export async function aiUpscale(path: string, maxEdge = 512): Promise<AiUpscaleResult | null> {
  try {
    return (await NativeModule?.aiUpscale(path, maxEdge)) ?? null;
  } catch {
    return null;
  }
}

export type PersonMask = { maskPath: string; width: number; height: number; coverage: number };

/** On-device person segmentation for Portrait photos (null if unavailable). */
export async function segmentPerson(path: string): Promise<PersonMask | null> {
  try {
    return (await NativeModule?.segmentPerson(path)) ?? null;
  } catch {
    return null;
  }
}

/** Open a saved photo/video in the gallery app (default) or via the "Open with" picker. */
export async function openMedia(id: string, isVideo: boolean, chooser: boolean): Promise<boolean> {
  try {
    if (!NativeModule) return false;
    await NativeModule.openMedia(id, isVideo, chooser);
    return true;
  } catch {
    return false;
  }
}

export type FaceBox = { x: number; y: number; w: number; h: number; confidence: number };

/** Faces in a photo (upright, normalized boxes) – used for face-priority exposure. */
export async function detectFaces(path: string): Promise<FaceBox[]> {
  try {
    return (await NativeModule?.detectFaces(path)) ?? [];
  } catch {
    return [];
  }
}

/** Crash report saved by the native handler on the previous run (cleared once read). */
export function takeLastCrash(): string | null {
  try {
    return NativeModule?.takeLastCrash() ?? null;
  } catch {
    return null;
  }
}

let NativeView: React.ComponentType<any> | null = null;
function nativeView() {
  if (!NativeView && NativeModule) NativeView = requireNativeView('ICamera');
  return NativeView;
}

export const cameraModuleAvailable = !!NativeModule;

export function getCapabilities(): Promise<Capabilities> {
  if (!NativeModule) return Promise.reject(new Error('Camera module is not available in this build'));
  return NativeModule.getCapabilities();
}

export const ICameraView = forwardRef<ICameraHandle, ICameraProps>((props, ref) => {
  const V = nativeView();
  return V ? React.createElement(V, { ...props, ref }) : null;
});
ICameraView.displayName = 'ICameraView';
