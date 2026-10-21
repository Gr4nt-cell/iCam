import { requireNativeView, requireOptionalNativeModule } from 'expo';
import React, { forwardRef } from 'react';
import type { ViewProps } from 'react-native';

export type CamMode = 'photo' | 'night' | 'pro' | 'video' | 'slowmo' | 'dual' | 'action';
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
  /** Extra displays apps may draw on (e.g. a phone's back screen) */
  rearDisplays: { id: number; name: string; width: number; height: number; presentation: boolean }[];
};

type NativeEvent<T> = { nativeEvent: T };

export type ReadyEvent = {
  mode: CamMode;
  slowMotionFps: number;
  nightExtension: boolean;
  zoomMin: number;
  zoomMax: number;
  hasFlash: boolean;
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
  stabilization?: 'off' | 'standard' | 'cinematic';
  nightExtension?: boolean;
  /** Show the viewfinder + controls on the phone's back screen */
  rearScreen?: boolean;
  rearUi?: { mode: 'photo' | 'video'; zoom: string; recording: boolean; seconds: number; countdown: number };
  onRearAction?: (e: NativeEvent<{ action: 'shutter' | 'mode' | 'zoom' | 'exit' }>) => void;
  onRearStatus?: (e: NativeEvent<{ active: boolean; reason?: string | null; display?: string }>) => void;
  onReady?: (e: NativeEvent<ReadyEvent>) => void;
  onError?: (e: NativeEvent<{ message: string }>) => void;
  onRecordingFinished?: (
    e: NativeEvent<{ path: string | null; durationMs: number; slowMotion: boolean; error: string | null }>,
  ) => void;
  onPhotosCaptured?: (e: NativeEvent<{ paths: string[]; error: string | null; nightExtension: boolean }>) => void;
};

export type ICameraHandle = {
  capture: (count: number, evShift: number) => Promise<void>;
  startRecording: () => Promise<void>;
  stopRecording: () => Promise<void>;
  focus: (x: number, y: number) => Promise<void>;
};

const NativeModule = requireOptionalNativeModule<{
  getCapabilities: () => Promise<Capabilities>;
  takeLastCrash: () => string | null;
}>('ICamera');

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
