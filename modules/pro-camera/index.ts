import { requireNativeView, requireOptionalNativeModule } from 'expo';
import React, { forwardRef } from 'react';
import type { ViewProps } from 'react-native';

export type ProMode = 'pro' | 'slowmo' | 'dual';
export type WhiteBalance = 'auto' | 'daylight' | 'cloudy' | 'shade' | 'tungsten' | 'fluorescent' | 'twilight' | 'kelvin';

export type ProCapabilities = {
  concurrent: boolean;
  slowMotion: boolean;
  manualSensor: boolean;
  manualWhiteBalance: boolean;
  isoMin: number;
  isoMax: number;
  exposureMinNs: number;
  exposureMaxNs: number;
  minFocusDistance: number;
};

type NativeEvent<T> = { nativeEvent: T };

export type ProCameraProps = ViewProps & {
  mode: ProMode;
  facing: 'back' | 'front';
  dualPrimary?: 'back' | 'front';
  /** 0 = auto. Manual exposure engages only when both iso and shutterNs are > 0. */
  iso?: number;
  shutterNs?: number;
  whiteBalance?: WhiteBalance;
  kelvin?: number;
  evBias?: number;
  /** Diopters; -1 = autofocus, 0 = infinity */
  focusDistance?: number;
  zoom?: number;
  torch?: boolean;
  mirror?: boolean;
  audio?: boolean;
  active?: boolean;
  onReady?: (e: NativeEvent<{ mode: ProMode; slowMotionFps: number; hasVideo: boolean; hasPhoto: boolean }>) => void;
  onError?: (e: NativeEvent<{ message: string }>) => void;
  onRecordingFinished?: (
    e: NativeEvent<{ path: string | null; durationMs: number; slowMotion: boolean; error: string | null }>,
  ) => void;
  onPhotoCaptured?: (e: NativeEvent<{ path: string }>) => void;
};

export type ProCameraHandle = {
  startRecording: () => Promise<void>;
  stopRecording: () => Promise<void>;
  takePhoto: () => Promise<void>;
};

const NativeModule = requireOptionalNativeModule<{ getCapabilities: () => Promise<ProCapabilities> }>('ProCamera');

let NativeView: React.ComponentType<any> | null = null;
function nativeView() {
  if (!NativeView && NativeModule) NativeView = requireNativeView('ProCamera');
  return NativeView;
}

export const proCameraAvailable = !!NativeModule;

export function getProCapabilities(): Promise<ProCapabilities> {
  if (!NativeModule) return Promise.reject(new Error('ProCamera native module not linked'));
  return NativeModule.getCapabilities();
}

export const ProCameraView = forwardRef<ProCameraHandle, ProCameraProps>((props, ref) => {
  const V = nativeView();
  return V ? React.createElement(V, { ...props, ref }) : null;
});
ProCameraView.displayName = 'ProCameraView';
