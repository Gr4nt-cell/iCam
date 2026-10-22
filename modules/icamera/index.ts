import { requireNativeView, requireOptionalNativeModule } from 'expo';
import React, { forwardRef } from 'react';
import type { ViewProps } from 'react-native';

export type CamMode = 'photo' | 'portrait' | 'night' | 'pro' | 'video' | 'pvideo' | 'slowmo' | 'dual' | 'action';
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
  onReady?: (e: NativeEvent<ReadyEvent>) => void;
  onError?: (e: NativeEvent<{ message: string }>) => void;
  onRecordingFinished?: (
    e: NativeEvent<{ path: string | null; durationMs: number; slowMotion: boolean; error: string | null }>,
  ) => void;
  onPhotosCaptured?: (
    e: NativeEvent<{
      paths: string[];
      evs?: number[];
      meta?: { orientation: number; width: number; height: number }[];
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
  focus: (x: number, y: number) => Promise<void>;
  movePip: (x: number, y: number) => Promise<void>;
};

const NativeModule = requireOptionalNativeModule<{
  getCapabilities: () => Promise<Capabilities>;
  takeLastCrash: () => string | null;
  detectFaces: (path: string) => Promise<FaceBox[]>;
  segmentPerson: (path: string) => Promise<PersonMask | null>;
  openMedia: (id: string, isVideo: boolean, chooser: boolean) => Promise<void>;
}>('ICamera');

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
