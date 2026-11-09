import { MaterialCommunityIcons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import * as MediaLibrary from 'expo-media-library';
import { StatusBar } from 'expo-status-bar';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Animated, { FadeIn, FadeInDown, FadeOut, FadeOutDown, LinearTransition } from 'react-native-reanimated';
import { AppState, PanResponder, PermissionsAndroid, Pressable, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import { SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  cameraModuleAvailable,
  detectFaces,
  openMedia,
  segmentPerson,
  getCapabilities,
  getCaptureRequest,
  finishCapture,
  cancelCapture,
  ICameraView,
  type Capabilities,
  type ICameraHandle,
  type ReadyEvent,
} from './modules/icamera';
import {
  lensStops,
  trim,
  type CaptureMode,
  type PhotoSettings,
  type VideoSettings,
} from './src/camera/hardware';
import { cameraViewport, restoreStabilization } from './src/camera/viewfinder';
import { GlassSegmented } from './src/ui/GlassSegmented';
import { rearCameraFrame, cameraFocusPoint, mirrorPhoto } from './src/camera/rearLayout';
import { filterByKey, type FilterKey } from './src/processing/filters';
import { processSingle, type PhotoMeta } from './src/processing/pipeline';
import { DEFAULT_PHOTO_SMOOTHING, restorePhotoSmoothing, captureSmoothing } from './src/processing/skinSettings';
import { CameraScreenPicker, RearCameraControls, RearCameraBackdrop, useCameraScreens } from './src/ui/RearCamera';
import {
  FocusRing,
  IconButton,
  MODES,
  ModeCarousel,
  Shutter,
  Thumb,
  Toast,
  ToneSliders,
  ZoomPills,
  type ShutterKind,
  Slider,
} from './src/ui/Controls';
import { clearSettings, loadDeviceFlags, loadSettings, saveDeviceFlags, saveSettings } from './src/settings';
import { DualPipFrame } from './src/ui/DualPip';
import { ErrorBoundary } from './src/ui/ErrorBoundary';
import { Glass, GlassCircle } from './src/ui/Glass';
import { AUTO_MANUAL, LookPanel, ProPanel, type ManualSettings } from './src/ui/ProPanel';
import { PermissionGate, SettingsSheet, Viewer } from './src/ui/Sheets';

type Flash = 'off' | 'auto' | 'on';
type Last = { uri?: string; original?: string; isVideo: boolean; info?: string; assetId?: string };
type GalleryPref = 'viewer' | 'gallery' | 'ask';
type BurstResult = {
  paths: string[];
  evs?: number[];
  meta?: PhotoMeta[];
  shortIndex?: number;
  error?: string | null;
  nightExtension: boolean;
};
type Aspect = '4:3' | '16:9' | '1:1' | 'full';
const ASPECTS: Aspect[] = ['4:3', '16:9', '1:1', 'full'];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const VIDEO_MODES: CaptureMode[] = ['video', 'slowmo', 'dual', 'action'];

export default function App() {
  return (
    <ErrorBoundary>
      <SafeAreaProvider>
        <CameraScreen />
      </SafeAreaProvider>
    </ErrorBoundary>
  );
}

function usePermissions() {
  const [camera, setCamera] = useState<boolean | null>(null);
  const [mic, setMic] = useState(false);
  const [mediaPerm, requestMedia] = MediaLibrary.usePermissions({ granularPermissions: ['photo', 'video'] });

  const refresh = useCallback(async () => {
    setCamera(await PermissionsAndroid.check(PermissionsAndroid.PERMISSIONS.CAMERA));
    setMic(await PermissionsAndroid.check(PermissionsAndroid.PERMISSIONS.RECORD_AUDIO));
  }, []);

  const requestAll = useCallback(async () => {
    const res = await PermissionsAndroid.requestMultiple([
      PermissionsAndroid.PERMISSIONS.CAMERA,
      PermissionsAndroid.PERMISSIONS.RECORD_AUDIO,
    ]);
    setCamera(res[PermissionsAndroid.PERMISSIONS.CAMERA] === PermissionsAndroid.RESULTS.GRANTED);
    setMic(res[PermissionsAndroid.PERMISSIONS.RECORD_AUDIO] === PermissionsAndroid.RESULTS.GRANTED);
    if (!mediaPerm?.granted) await requestMedia().catch(() => {});
  }, [mediaPerm, requestMedia]);

  useEffect(() => {
    refresh().then(requestAll);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { camera, mic, media: !!mediaPerm?.granted, requestAll };
}

function CameraScreen() {
  const insets = useSafeAreaInsets();
  const cam = useRef<ICameraHandle>(null);
  const perms = usePermissions();

  /* ---------- state ---------- */
  const [mode, setMode] = useState<CaptureMode>('photo');
  const [facing, setFacing] = useState<'back' | 'front'>('back');
  const [flash, setFlash] = useState<Flash>('off');
  const [timer, setTimer] = useState<0 | 3 | 10>(0);
  const [zoom, setZoom] = useState(1);
  const [zoomRange, setZoomRange] = useState({ min: 1, max: 8 });
  const [brightness, setBrightness] = useState(0);
  const [shadows, setShadows] = useState(0);
  const [photo, setPhoto] = useState<PhotoSettings>({ frames: 4, vendorNight: true, highlightBracket: true });
  const [video, setVideo] = useState<VideoSettings>({
    resolution: '1080p',
    fps: 30,
    hdr: false,
    stabilization: 'cinematic',
  });
  const [mirrorSelfie, setMirrorSelfie] = useState(true);
  const [filter, setFilter] = useState<FilterKey>('natural');
  const [smoothing, setSmoothing] = useState(0);
  const [photoSmoothing, setPhotoSmoothing] = useState(DEFAULT_PHOTO_SMOOTHING);
  const [manual, setManual] = useState<ManualSettings>(AUTO_MANUAL);
  const [proVideo, setProVideo] = useState(false);
  const [dualPrimary, setDualPrimary] = useState<'back' | 'front'>('back');
  const [caps, setCaps] = useState<Capabilities | null>(null);
  const [ready, setReady] = useState<ReadyEvent | null>(null);
  const [pip, setPip] = useState({ x: 0.74, y: 0.22, size: 0.34 });
  const [aspect, setAspect] = useState<Aspect>('4:3');
  const [bokeh, setBokeh] = useState(0.6);
  const [galleryPref, setGalleryPref] = useState<GalleryPref>('viewer');
  const [weakGpu, setWeakGpu] = useState(false);
  useEffect(() => {
    loadDeviceFlags().then((f) => setWeakGpu(!!f.weakGpu));
  }, []);
  const win = useWindowDimensions();
  const [remember, setRemember] = useState(false);
  const [settingsLoaded, setSettingsLoaded] = useState(false);

  const [busy, setBusy] = useState(false);
  const [processing, setProcessing] = useState(false);
  const [recording, setRecording] = useState(false);
  const [recSeconds, setRecSeconds] = useState(0);
  const [paused, setPaused] = useState(false);
  const [palmShutter, setPalmShutter] = useState(false);
  const [shutterSound, setShutterSound] = useState(true);
  // Palm shutter live state: off | none | hand | palm | error:…
  const [palmStatus, setPalmStatus] = useState('off');
  // A rear lens opened directly (one the default camera's zoom can't reach), else null
  const [lensId, setLensId] = useState<string | null>(null);
  // Another app asked iCam for a photo/video (iCam as the default camera)
  const [captureReq] = useState(() => getCaptureRequest());

  const [countdown, setCountdown] = useState(0);
  const [last, setLast] = useState<Last | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [focus, setFocus] = useState<{ x: number; y: number; key: number } | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [viewerOpen, setViewerOpen] = useState(false);
  const [appActive, setAppActive] = useState(true);

  /* ---------- remembered settings ---------- */
  type Saved = {
    remember: boolean;
    mode: CaptureMode;
    photo: PhotoSettings;
    video: VideoSettings;
    mirrorSelfie: boolean;
    filter: FilterKey;
    smoothing: number;
    photoSmoothing?: number;
    pip: typeof pip;
    manual: ManualSettings;
    brightness: number;
    shadows: number;
    aspect: Aspect;
    bokeh: number;
    galleryPref: GalleryPref;
    videoV2?: boolean;
    palmShutter?: boolean;
    shutterSound?: boolean;
  };
  useEffect(() => {
    loadSettings<Saved>().then((v) => {
      if (v?.remember) {
        setRemember(true);
        if (v.photo) setPhoto((p) => ({ ...p, ...v.photo }));
        // HDR defaults off, but preserve an explicitly saved choice now that HDR processing is supported.
        if (v.video) setVideo((x) => ({ ...x, ...v.video, stabilization: restoreStabilization(v.video?.stabilization) }));
        if (v.mode) setMode(v.mode === 'pvideo' ? 'video' : v.mode); // Portrait video was removed
        if (typeof v.mirrorSelfie === 'boolean') setMirrorSelfie(v.mirrorSelfie);
        if (v.filter === 'natural' || v.filter === 'mono') setFilter(v.filter);
        if (typeof v.palmShutter === 'boolean') setPalmShutter(v.palmShutter);
        if (typeof v.shutterSound === 'boolean') setShutterSound(v.shutterSound);
        if (typeof v.smoothing === 'number') setSmoothing(v.smoothing);
        setPhotoSmoothing(restorePhotoSmoothing(v.photoSmoothing, v.smoothing));
        if (v.pip) setPip(v.pip);
        if (v.manual) setManual(v.manual);
        if (typeof v.brightness === 'number') setBrightness(v.brightness);
        if (typeof v.shadows === 'number') setShadows(v.shadows);
        if (v.aspect) setAspect(v.aspect);
        if (typeof v.bokeh === 'number') setBokeh(v.bokeh);
        if (v.galleryPref) setGalleryPref(v.galleryPref);
      }
      setSettingsLoaded(true);
    });
  }, []);
  useEffect(() => {
    if (!settingsLoaded) return;
    if (!remember) return;
    const t = setTimeout(
      () => saveSettings({ videoV2: true, palmShutter, shutterSound, remember, mode, photo, video, mirrorSelfie, filter, smoothing, photoSmoothing, pip, manual, brightness, shadows, aspect, bokeh, galleryPref }),
      400,
    );
    return () => clearTimeout(t);
  }, [settingsLoaded, remember, mode, photo, video, mirrorSelfie, filter, smoothing, photoSmoothing, pip, manual, brightness, shadows, aspect, bokeh, galleryPref, palmShutter, shutterSound]);

  useEffect(() => {
    const sub = AppState.addEventListener('change', (s) => setAppActive(s === 'active'));
    return () => sub.remove();
  }, []);

  useEffect(() => {
    if (!perms.camera || !cameraModuleAvailable) return;
    getCapabilities()
      .then(setCaps)
      .catch(() => setCaps(null));
  }, [perms.camera]);

  const shutterKind: ShutterKind =
    mode === 'night'
      ? 'night'
      : mode === 'photo' || mode === 'portrait'
        ? 'photo'
        : mode === 'pro' && !proVideo
          ? 'photo'
          : 'video';
  const isPhotoShot = shutterKind !== 'video';
  const isVideoMode = VIDEO_MODES.includes(mode) || (mode === 'pro' && proVideo);

  const visibleModes = useMemo(
    () =>
      MODES.filter((m) => {
        if (m.key === 'slowmo') return !!caps?.slowMotion;
        if (m.key === 'dual') return !!caps?.concurrent;
        // Macro only on phones with a dedicated macro camera or a close-focusing telephoto
        if (m.key === 'macro') return !!caps?.macro;
        // Live background blur needs a capable GPU: hidden on weak phones (or after it proved too slow)
        return true;
      }),
    [caps, weakGpu],
  );

  // Zoom reach from the lens data: telephoto phones go far past the hardware zoom (digital, with
  // detail reconstruction for photos); phones without a telephoto stop at 2×
  const DIGITAL_ZOOM_MODES: CaptureMode[] = ['photo', 'night', 'portrait', 'pro', 'video', 'action'];
  const maxZoom =
    facing === 'back' && DIGITAL_ZOOM_MODES.includes(mode)
      ? caps?.maxZoom ?? Math.min(zoomRange.max, 2)
      : Math.min(zoomRange.max, 4);
  const telephoto = facing === 'back' && !!caps?.telephoto && DIGITAL_ZOOM_MODES.includes(mode);
  const rearLenses = caps?.rearLenses ?? [];
  const activeLens = lensId ? rearLenses.find((l) => l.id === lensId) : undefined;
  // zoom as the user sees it (relative to the main lens)
  const shownZoom = activeLens ? activeLens.ratio * zoom : zoom;
  const stops = useMemo(() => {
    const base = lensStops(lensId ? 1 : zoomRange.min, Math.min(lensId ? 2.01 : maxZoom, 2.01));
    if (facing === 'back' && DIGITAL_ZOOM_MODES.includes(mode)) {
      const inMulti = (k: string) => rearLenses.some((l) => l.parentId && l.kind.includes(k));
      for (const l of rearLenses) {
        if (!l.selectable || l.parentId) continue;
        // ultrawide not reachable by zooming out, or a telephoto that isn't part of the main multi-camera
        const uw = l.kind === 'ultrawide' && zoomRange.min >= 0.95 && !inMulti('ultrawide');
        const tele = l.kind.includes('telephoto') && !inMulti('telephoto') && l.ratio > zoomRange.max * 0.9;
        if (uw || tele) base.push({ label: trim(l.ratio), zoom: l.ratio, lensId: l.id });
      }
      base.sort((a, b) => a.zoom - b.zoom);
    }
    if (telephoto && caps?.telephotoRatio) {
      const t = Math.round(caps.telephotoRatio);
      if (t > 2 && t <= maxZoom) base.push({ label: String(t), zoom: t });
      if (maxZoom >= 10 && t < 8) base.push({ label: '10', zoom: 10 });
    }
    return base;
  }, [zoomRange, maxZoom, telephoto, caps, lensId, facing, mode, rearLenses]);
  // Full sensor preserves the 4:3 field instead of cropping it to the phone screen.
  const aspectRatio = aspect === '4:3' ? 3 / 4 : aspect === '16:9' ? 9 / 16 : aspect === '1:1' ? 1 : 3 / 4;

  useEffect(() => {
    setZoom((z) => Math.min(z, maxZoom));
  }, [maxZoom]);
  // a directly-opened lens only applies to the back camera in photo/video modes
  useEffect(() => {
    if (facing !== 'back' || !DIGITAL_ZOOM_MODES.includes(mode)) setLensId(null);
  }, [facing, mode]);

  useEffect(() => {
    if (captureReq === 'video') setMode('video');
    else if (captureReq === 'image') setMode('photo');
  }, [captureReq]);

  /* ---------- helpers ---------- */
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flashToast = useCallback((t: string, ms = 2200) => {
    setToast(t);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), ms);
  }, []);

  // Display switching owns no camera: the existing camera activity moves as one task.
  const screens = useCameraScreens(recording || busy || processing || countdown > 0, flashToast);
  const wasSecondary = useRef(false);
  useEffect(() => {
    if (screens.onSecondary && !wasSecondary.current && !recording && !busy) {
      setFacing('back'); setLensId(null); setZoom(1);
      setSettingsOpen(false); setViewerOpen(false);
    }
    wasSecondary.current = screens.onSecondary;
  }, [screens.onSecondary, recording, busy]);

  const changeMode = useCallback(
    (m: CaptureMode) => {
      if (recording || m === mode) return;
      Haptics.selectionAsync();
      setMode(m);
    },
    [recording, mode],
  );

  const saveToGallery = useCallback(
    async (uri: string): Promise<string | undefined> => {
      if (!perms.media) return undefined;
      const asset = await MediaLibrary.createAssetAsync(uri);
      return asset?.id;
    },
    [perms.media],
  );

  /* ---------- burst capture plumbing (native emits onPhotosCaptured) ---------- */
  const burstWaiter = useRef<((r: BurstResult) => void) | null>(null);
  const captureBurst = useCallback(
    (count: number, evShift: number, shortEv: number) =>
      new Promise<BurstResult>((resolve, reject) => {
        const c = cam.current;
        if (!c) return reject(new Error('Camera not ready'));
        burstWaiter.current = resolve;
        c.capture(count, evShift, shortEv).catch((e) => {
          burstWaiter.current = null;
          reject(e);
        });
      }),
    [],
  );

  /* ---------- capture: photo / night / pro photo ---------- */
  /** Front camera: does the JPEG need flipping to match the mirror setting? (1 = phone already mirrored it) */
  const needsFlip = (jpegMirrored?: number) =>
    mirrorPhoto(facing,mirrorSelfie,screens.onSecondary,jpegMirrored);

  // Photos are processed one after another in the background, so the shutter is free again as soon
  // as the camera has the frame (shot-to-shot no longer waits for processing and saving)
  const procQueue = useRef<Promise<void>>(Promise.resolve());
  const pendingJobs = useRef(0);

  const shootPhoto = useCallback(async () => {
    if (busy || !ready) return;
    const night = mode === 'night';
    const pro = mode === 'pro';
    const ext: string | null = (ready as any).extension ?? null;

    setBusy(true);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    let paths: string[] = [];
    let meta0: PhotoMeta | undefined;
    try {
      // One full-quality frame; the phone's own image processor (vendor HDR / Bokeh / Night) does the heavy lifting
      const res = await captureBurst(1, 0, 0);
      paths = res.paths;
      meta0 = res.meta?.[0];
      if (!paths.length) throw new Error(res.error ?? 'No photo captured');
    } catch (e: any) {
      flashToast(String(e?.message ?? e).slice(0, 80), 4000);
      setBusy(false);
      return;
    }

    const original = `file://${paths[0]}`;
    setLast({ uri: original, original, isVideo: false });
    // everything the job needs is fixed now (later setting changes don't affect this shot)
    const shot = { mode, facing, zoom, zoomMax: zoomRange.max, smoothing: captureSmoothing(mode, photoSmoothing, smoothing), filter, aspectRatio, bokeh, captureReq, macroKind: caps?.macroKind };
    const flip = needsFlip(meta0?.jpegMirrored);

    const job = async () => {
      try {
        const look = [shot.filter !== 'natural' && filterByKey(shot.filter).label, shot.smoothing > 0.01 && 'smoothed']
          .filter(Boolean)
          .join(' · ');
        let portrait: { maskPath: string; strength: number } | undefined;
        if (shot.mode === 'portrait' && ext !== 'bokeh') {
          // No hardware depth bokeh on this phone: blur the background from a person/subject mask
          const mask = await segmentPerson(paths[0]);
          if (mask && mask.coverage > 0.02) portrait = { maskPath: mask.maskPath, strength: shot.bokeh };
          else flashToast('No subject found — saved without background blur', 3000);
        }
        const back = shot.facing === 'back';
        const ai = back && shot.zoom > shot.zoomMax * 1.5;
        if (ai) setToast('AI zoom · rebuilding detail…');
        const uri = await processSingle(paths[0], {
          smoothing: shot.smoothing,
          filter: shot.filter,
          aspect: shot.aspectRatio,
          meta: meta0,
          portrait,
          // Mirror selfie: flip only if the JPEG isn't already the way the user wants it
          mirror: flip,
          enhance: pro ? 0.3 : ext ? 0.45 : 1,
          digitalZoom: back ? shot.zoom / Math.max(1, shot.zoomMax) : 1,
          // Beyond the lens (≥1.5× digital): rebuild detail with the on-device AI model
          aiZoom: ai,
        });
        const info = shot.mode === 'macro'
          ? `Macro${shot.macroKind === 'tele' ? ' (telephoto)' : ''}`
          : pro
          ? 'Pro'
          : night
            ? ext === 'night' ? 'Night (phone)' : 'Night'
            : shot.mode === 'portrait'
              ? ext === 'bokeh' ? 'Portrait (depth)' : portrait ? 'Portrait (subject mask)' : 'Portrait'
              : ext === 'hdr' ? 'Photo (phone HDR)' : ext === 'auto' ? 'Photo (phone Auto)' : 'Photo';
        const zoomNote = back && shot.zoom > shot.zoomMax * 1.01 ? ` · ${Math.round(shot.zoom)}× ${ai ? 'AI zoom' : 'detail zoom'}` : '';
        if (shot.captureReq === 'image') {
          // Requested by another app: hand the photo back instead of saving it to the gallery
          flashToast('Sending photo…');
          if (await finishCapture(uri, false)) return;
        }
        const assetId = await saveToGallery(uri);
        setLast({ uri, original, isVideo: false, info: (look ? `${info} · ${look}` : info) + zoomNote, assetId });
        flashToast('Saved');
      } catch (e: any) {
        // Minimal fallback that still honours selfie mirroring and aspect ratio
        const fallback = await processSingle(paths[0], {
          smoothing: 0,
          filter: 'natural',
          aspect: shot.aspectRatio,
          meta: meta0,
          mirror: flip,
        }).catch(() => original);
        await saveToGallery(fallback).catch(() => {});
        flashToast(`Saved original — ${String(e?.message ?? e).slice(0, 80)}`, 4000);
      }
    };

    pendingJobs.current += 1;
    setProcessing(true);
    procQueue.current = procQueue.current.then(job).finally(() => {
      pendingJobs.current -= 1;
      if (pendingJobs.current === 0) setProcessing(false);
    });
    // a photo requested by another app finishes before anything else can happen
    if (captureReq === 'image') await procQueue.current;
    setBusy(false);
  }, [busy, ready, mode, facing, mirrorSelfie, captureReq, zoom, zoomRange, smoothing, photoSmoothing, screens.onSecondary, filter, aspectRatio, bokeh, caps, captureBurst, saveToGallery, flashToast]);

  /* ---------- capture: video ---------- */
  const toggleRecording = useCallback(async () => {
    const c = cam.current;
    if (!c || busy) return;
    if (recording) {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      await c.stopRecording();
      return;
    }
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy);
    setRecSeconds(0);
    setPaused(false);
    setRecording(true);
    await c.startRecording().catch((e) => {
      setRecording(false);
      flashToast(String(e?.message ?? e), 4000);
    });
  }, [recording, busy, flashToast]);

  useEffect(() => {
    if (!recording || paused) return;
    const id = setInterval(() => setRecSeconds((s) => s + 1), 1000);
    return () => clearInterval(id);
  }, [recording, paused]);

  const togglePause = useCallback(() => {
    const c = cam.current;
    if (!c || !recording) return;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    if (paused) c.resumeRecording().catch(() => {});
    else c.pauseRecording().catch(() => {});
    setPaused(!paused);
  }, [recording, paused]);

  // Front/back can be switched mid-recording in Video and Action (the clip continues)
  // Video / Action: switching cameras mid-recording records a new piece; pieces are joined at the end
  const canFlipWhileRecording = !video.hdr && (mode === 'video' || mode === 'action');

  const runCountdown = useCallback(async (secs: number) => {
    for (let t = secs; t > 0; t--) {
      setCountdown(t);
      Haptics.selectionAsync();
      await sleep(1000);
    }
    setCountdown(0);
  }, []);

  const onShutter = useCallback(async () => {
    if (screens.switching) return;
    if (isVideoMode) {
      // timer delays the start of a recording (stopping is immediate)
      if (!recording && timer > 0) await runCountdown(timer);
      return toggleRecording();
    }
    if (timer > 0) {
      for (let t = timer; t > 0; t--) {
        setCountdown(t);
        Haptics.selectionAsync();
        await sleep(1000);
      }
      setCountdown(0);
    }
    return shootPhoto();
  }, [isVideoMode, recording, timer, runCountdown, toggleRecording, shootPhoto, screens.switching]);

  // Palm shutter → 3 s timer then shoot
  const onGesture = useCallback(
    async () => {
      if (busy || countdown > 0 || recording || isVideoMode) return;
      flashToast('Palm detected', 1200);
      await runCountdown(3);
      shootPhoto();
    },
    [busy, countdown, recording, isVideoMode, flashToast, runCountdown, shootPhoto],
  );

 /* ---------- open the last capture: iCam viewer, gallery app, or "Open with" ---------- */
  const openLast = useCallback(async () => {
    if (!last) return;
    if (!last.assetId) {
      flashToast('Still saving — try again in a moment');
      return;
    }
    const ok = await openMedia(last.assetId, last.isVideo, false);
    if (!ok) flashToast('No gallery app is available to open it');
  }, [last, flashToast]);

  const viewport = cameraViewport(win.width, win.height, isVideoMode, aspect, insets.top, insets.bottom);

  /* ---------- gestures: tap-to-focus, pinch-to-zoom, swipe modes ---------- */
  const live = useRef({ zoom, zoomRange, mode, recording, visibleModes, maxZoom, rear: screens.onSecondary, width: win.width, height: win.height, frame: viewport });
  live.current = { zoom, zoomRange, mode, recording, visibleModes, maxZoom, rear: screens.onSecondary, width: win.width, height: win.height, frame: viewport };
  const gesture = useRef({ pinchStart: 0, zoomStart: 1, pinched: false });
  const onShutterRef = useRef(onShutter);
  onShutterRef.current = onShutter;
  const changeModeRef = useRef(changeMode);
  changeModeRef.current = changeMode;

  const responder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: () => true,
        onPanResponderGrant: () => {
          gesture.current = { pinchStart: 0, zoomStart: live.current.zoom, pinched: false };
        },
        onPanResponderMove: (e) => {
          const t = e.nativeEvent.touches;
          if (t.length < 2) return;
          const dist = Math.hypot(t[0].pageX - t[1].pageX, t[0].pageY - t[1].pageY);
          if (!gesture.current.pinchStart) {
            gesture.current.pinchStart = dist;
            gesture.current.zoomStart = live.current.zoom;
          }
          gesture.current.pinched = true;
          const { min } = live.current.zoomRange;
          setZoom(clamp(gesture.current.zoomStart * (dist / gesture.current.pinchStart), min, live.current.maxZoom));
        },
        onPanResponderRelease: (e, g) => {
          if (gesture.current.pinched) return;
          const L = live.current;
          if (Math.abs(g.dx) < 10 && Math.abs(g.dy) < 10) {
            const { locationX: x, locationY: y } = e.nativeEvent;
            const point=cameraFocusPoint(x,y,L.width,L.height,L.rear);
            if(!point)return;
            setFocus({ x: x + (L.rear ? 0 : L.frame.left), y: y + (L.rear ? 0 : L.frame.top), key: Date.now() });
            cam.current?.focus(point.x, point.y).catch(() => {});
          } else if (Math.abs(g.dx) > 70 && Math.abs(g.dx) > Math.abs(g.dy) * 1.5 && !L.recording) {
            const list = L.visibleModes;
            const idx = list.findIndex((m) => m.key === L.mode);
            const next = list[clamp(idx + (g.dx < 0 ? 1 : -1), 0, list.length - 1)];
            changeModeRef.current(next.key);
          }
        },
      }),
    [],
  );

  /* ---------- render ---------- */
  if (perms.camera === null) return <View style={styles.root} />;
  if (!perms.camera) {
    const missing = ['Camera', !perms.mic && 'Microphone', !perms.media && 'Photos & videos'].filter(Boolean) as string[];
    return (
      <>
        <StatusBar style="light" hidden />
        <PermissionGate missing={missing} onGrant={perms.requestAll} />
      </>
    );
  }

  const mm = String(Math.floor(recSeconds / 60)).padStart(2, '0');
  const ss = String(recSeconds % 60).padStart(2, '0');

  const badge =
    mode === 'night'
      ? ready?.nightExtension
        ? 'NIGHT · PHONE'
        : 'NIGHT'
      : mode === 'photo'
        ? (ready as any)?.extension === 'hdr' ? 'HDR' : (ready as any)?.extension === 'auto' ? 'AUTO' : 'PHOTO'
        : mode === 'portrait'
          ? ((ready as any)?.extension === 'bokeh' ? 'PORTRAIT · DEPTH' : 'PORTRAIT')
        : mode === 'pro'
          ? proVideo
            ? 'PRO VIDEO'
            : 'PRO'
          : mode === 'slowmo'
            ? `SLO-MO${ready?.slowMotionFps ? ` · ${ready.slowMotionFps}` : ''}`
            : mode === 'dual'
              ? 'DUAL'
              : mode === 'action'
                ? 'ACTION'
                : `${video.resolution === '4k' ? '4K' : '1080p'} · ${video.fps}`;

  const topStatus = mode === 'action' ? 'ACTION' : mode === 'video' ? 'VIDEO' : mode === 'macro' ? 'MACRO' : badge;
  const qualityLabel = mode === 'action' ? `${ready?.recordingFps ?? (facing === 'front' ? 30 : 60)} FPS` : mode === 'pro' && proVideo ? '4K · 60' : mode === 'video' ? (video.resolution === '4k' ? '4K' : '1080p') + ' · ' + (ready?.recordingFps ?? video.fps) : aspect === 'full' ? 'SENSOR' : aspect;

  return (
    <View style={styles.root}>
      <StatusBar style="light" hidden />

      {screens.onSecondary && <RearCameraBackdrop />}
      {cameraModuleAvailable ? (
        <ICameraView
          ref={cam}
          style={screens.onSecondary ? {...rearCameraFrame(win.width,win.height),position: 'absolute',borderRadius:16,overflow:'hidden'} : { ...viewport, position: 'absolute', overflow: 'hidden' }}
          mode={mode === 'pro' && proVideo ? 'video' : mode}
          facing={facing}
          dualPrimary={dualPrimary}
          zoom={zoom}
          evBias={mode === 'pro' ? manual.ev : brightness * 2}
          iso={manual.iso}
          shutterNs={manual.shutterNs}
          whiteBalance={manual.whiteBalance}
          kelvin={manual.kelvin}
          focusDistance={manual.focusDistance}
          flash={isVideoMode ? 'off' : flash}
          torch={isVideoMode && flash === 'on'}
          mirror={mirrorSelfie}
          rearSelfie={screens.onSecondary}
          audio={perms.mic}
          active={appActive && !viewerOpen}
          videoQuality={video.resolution === '4k' ? 'uhd' : 'fhd'}
          fps={video.fps}
          hdrVideo={video.hdr}
          manualControls={mode === 'pro'}
          antibanding={video.antibanding ?? 'country'}
          stabilization={video.stabilization}
          faceSmoothing={smoothing}
          palmShutter={palmShutter}
          shutterSound={shutterSound}
          lensId={facing === 'back' && DIGITAL_ZOOM_MODES.includes(mode) ? lensId : null}
          onGesture={(e) => {
            const g = e.nativeEvent;
            if (g.kind === 'status') {
              const st = g.status ?? 'off';
              if (st.startsWith('error:') && !palmStatus.startsWith('error:')) flashToast(`Palm shutter: ${st.slice(6)}`, 5000);
              setPalmStatus(st);
            } else onGesture();
          }}
          filterParams={(() => {
            const f = filterByKey(filter);
            return [f.sat, f.contrast, f.warmth, f.fade, f.mono, f.vignette];
          })()}
          nightExtension={photo.vendorNight}
          dualPip={pip}
          aspect={aspect === '16:9' ? '16:9' : '4:3'}
          previewFit={!isPhotoShot || aspect !== '1:1'}
          bokeh={bokeh}
          onPortraitStatus={(e) => {
            if (e.nativeEvent.blur === false) {
              setWeakGpu(true);
              saveDeviceFlags({ weakGpu: true });
              flashToast(e.nativeEvent.reason ?? 'Background blur turned off on this phone', 4500);
            }
          }}
          onReady={(e) => {
            const r = e.nativeEvent;
            setReady(r);
            setZoomRange({ min: r.zoomMin, max: r.zoomMax });
            setZoom((z) => clamp(z, r.zoomMin, Math.max(r.zoomMax, live.current.maxZoom)));
            if (r.mode === 'slowmo' && r.slowMotionFps) flashToast(`Slow motion · ${r.slowMotionFps} fps`);
          }}
          onError={(e) => {
            setBusy(false);
            setRecording(false);
            flashToast(e.nativeEvent.message, 4000);
          }}
          onPhotosCaptured={(e) => {
            const w = burstWaiter.current;
            burstWaiter.current = null;
            w?.(e.nativeEvent);
          }}
          onRecordingState={(e) => {
            const st = e.nativeEvent as { paused?: boolean; merging?: boolean; processing?: boolean };
            if (st.processing) {
              setRecording(false);
              setPaused(false);
              setBusy(true);
              setProcessing(true);
            } else if (st.merging) {
              setRecording(false); setPaused(false); setBusy(true);
              setProcessing(true); // camera-switch segments still need to be joined
            } else if (typeof st.paused === 'boolean') setPaused(st.paused);
          }}
          onRecordingFinished={async (e) => {
            setBusy(false);
            setRecording(false);
            setPaused(false);
            setProcessing(false);
            const { path, durationMs, slowMotion, error } = e.nativeEvent;
            const extra = (e.nativeEvent as { extraPaths?: string[] }).extraPaths ?? [];
            for (const x of extra) await saveToGallery(`file://${x}`).catch(() => undefined);
            if (error && path) flashToast(error, 4000);
            if (!path) {
              flashToast(error ?? 'Recording failed', 4000);
              return;
            }
            if (captureReq === 'video' && (await finishCapture(`file://${path}`, true))) return;
            try {
              const assetId = await saveToGallery(`file://${path}`);
              setLast({
                isVideo: true,
                assetId,
                info: `${slowMotion ? 'Slow motion · ' : mode === 'dual' ? 'Dual · ' : ''}${Math.round(durationMs / 1000)} s`,
              });
              flashToast(slowMotion ? 'Slow-motion video saved' : 'Video saved');
            } catch {
              flashToast('Could not save video');
            }
          }}
        />
      ) : (
        <View style={[StyleSheet.absoluteFill, styles.center]}>
          <Text style={styles.dim}>Camera module missing from this build</Text>
        </View>
      )}

      <View style={screens.onSecondary ? StyleSheet.absoluteFill : { ...viewport, position: 'absolute' }} {...responder.panHandlers} />
      {!screens.onSecondary && <>
      {focus && <FocusRing key={focus.key} x={focus.x} y={focus.y} />}

      {/* Floating camera instruments */}
      <View style={[styles.top, { top: viewport.top + 8, left: viewport.left + 10, right: win.width - viewport.left - viewport.width + 10 }]} pointerEvents="box-none">
        <View style={styles.topRow}>
          <Glass radius={26} style={styles.topPill}>
            {(isPhotoShot || isVideoMode) && (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`Capture format: ${qualityLabel}`}
                hitSlop={8}
                disabled={!isPhotoShot && mode !== 'video'}
                style={styles.qualityChip}
                onPress={() => {
                  if (mode === 'video') setVideo((v) => ({ ...v, resolution: v.resolution === '4k' ? '1080p' : '4k' }));
                  else if (isPhotoShot) {
                    Haptics.selectionAsync();
                    setAspect((a) => ASPECTS[(ASPECTS.indexOf(a) + 1) % ASPECTS.length]);
                  }
                }}
              >
                <Text numberOfLines={1} style={styles.qualityText}>{qualityLabel}</Text>
                <MaterialCommunityIcons name="chevron-down" size={13} color="rgba(255,255,255,0.78)" />
              </Pressable>
            )}
          </Glass>
          <View style={{ flex: 1 }} />
          <Glass radius={24} style={styles.instrumentCluster}>
          {screens.available && <Pressable accessibilityRole="button" accessibilityLabel="Switch camera screen" disabled={recording || busy || processing || countdown > 0 || screens.switching} onPress={() => screens.setOpen(true)} style={styles.controlButton}>
            <MaterialCommunityIcons name="monitor-cellphone" size={22} color="#ffe16b" />
          </Pressable>}
          <Pressable accessibilityRole="button" accessibilityLabel="Camera settings" hitSlop={8} onPress={() => setSettingsOpen(true)} style={styles.controlButton}>
            <GlassCircle size={44}><MaterialCommunityIcons name="tune-variant" size={21} color="#fff" /></GlassCircle>
          </Pressable>
          </Glass>
        </View>
        <View style={styles.topMetaRow}>
          <View style={styles.topMetaChip}>
            <View style={styles.statusDot} />
            <Text numberOfLines={1} style={styles.topMetaLabel}>{topStatus}</Text>
          </View>
          <View style={styles.topMetaTools}>
            {(facing === 'front' || mode === 'dual') && (
              <Pop>
                <Pressable hitSlop={8} style={styles.metaTool} onPress={() => setMirrorSelfie((v) => !v)}>
                  <MaterialCommunityIcons name="flip-horizontal" size={17} color={mirrorSelfie ? '#ffe16b' : '#fff'} />
                </Pressable>
              </Pop>
            )}
            {palmShutter && palmStatus !== 'off' && (
              <Pop>
                <View style={styles.metaTool}>
                  <MaterialCommunityIcons name="hand-back-right-outline" size={16} color={palmStatus === 'palm' ? '#ffe16b' : palmStatus === 'hand' ? '#fff' : palmStatus.startsWith('error') ? '#ff6b5f' : 'rgba(255,255,255,0.45)'} />
                </View>
              </Pop>
            )}
          </View>

        </View>
        {recording && (
          <Animated.View layout={SUBBAR_MOVE} style={styles.recordingBar}>
            <Glass radius={18} style={styles.subBar} tint="rgba(255,59,48,0.45)">
              <View style={[styles.recLed, paused && { opacity: 0.4 }]} />
              <Text style={styles.recText}>{paused ? 'PAUSED · ' : ''}{mm}:{ss}</Text>
            </Glass>
          </Animated.View>
        )}
      </View>

      {mode === 'dual' && (
        <View style={{ ...viewport, position: 'absolute' }} pointerEvents="box-none"><DualPipFrame
          frameSize={viewport}
          pip={pip}
          locked={recording}
          onMove={(x, y) => setPip((p) => ({ ...p, x, y }))}
          onLiveMove={(x, y) => {
            cam.current?.movePip(x, y).catch(() => {});
          }}
          onSwap={() => {
            if (recording) return;
            Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
            setDualPrimary((p) => (p === 'back' ? 'front' : 'back'));
          }}
        /></View>
      )}

      {captureReq && (
        <Animated.View entering={FadeIn.duration(220)} exiting={FadeOut.duration(180)} style={{ position: 'absolute', top: insets.top + 106, alignSelf: 'center' }}>
          <Glass radius={18} style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 14, height: 36 }}>
            <Text style={{ color: '#fff', fontWeight: '700', fontSize: 13 }}>
              {captureReq === 'image' ? 'Take a photo for the app' : 'Record a video for the app'}
            </Text>
            <Pressable hitSlop={10} onPress={() => cancelCapture()}>
              <MaterialCommunityIcons name="close" size={18} color="#fff" />
            </Pressable>
          </Glass>
        </Animated.View>
      )}

      {countdown > 0 && (
        <View style={[StyleSheet.absoluteFill, styles.center]} pointerEvents="none">
          <Animated.Text key={countdown} entering={FadeIn.duration(160)} exiting={FadeOut.duration(200)} style={styles.countdown}>
            {countdown}
          </Animated.Text>
        </View>
      )}

        <Animated.View layout={GLIDE} style={[styles.zoomFloat, { position: 'absolute', bottom: win.height - viewport.top - viewport.height + 12, left: viewport.left, width: viewport.width }]}>
          <ZoomPills
            stops={stops}
            zoom={shownZoom}
            label={shownZoom >= 10 ? String(Math.round(shownZoom)) : trim(shownZoom)}
            onSelect={(z, st) => {
              Haptics.selectionAsync();
              if (st?.lensId) {
                setLensId(st.lensId);
                setZoom(1);
              } else {
                setLensId(null);
                setZoom(z);
              }
            }}
            min={zoomRange.min}
            max={maxZoom}
            dialEnabled={telephoto}
            onDial={setZoom}
          />
        </Animated.View>
      {/* Floating lower camera deck */}
      <View style={[styles.bottom, { paddingBottom: insets.bottom + 6 }, win.width > win.height && { left: undefined, right: 4, width: 176 }]} pointerEvents="box-none">
        <Toast text={toast} />

        <Animated.View layout={GLIDE}>
          <View style={styles.shutterDeck}>
            <View style={styles.shutterRow}>
              {recording && mode !== 'slowmo' ? (
                <Animated.View key="pause" entering={FadeIn.duration(160)} exiting={FadeOut.duration(120)} style={styles.galleryAnchor}>
                  <IconButton icon={paused ? 'record' : 'pause'} size={44} onPress={togglePause} />
                </Animated.View>
              ) : (
                <Animated.View key="thumb" entering={FadeIn.duration(160)} exiting={FadeOut.duration(120)} style={styles.galleryAnchor}>
                  <Thumb uri={last?.uri} processing={processing} onPress={openLast} isVideo={!!last?.isVideo} enabled={!!last} />
                </Animated.View>
              )}
              <Shutter kind={shutterKind} recording={recording} busy={busy || countdown > 0 || screens.switching} onPress={onShutter} />
              <View style={styles.flipAnchor}>
              {mode === 'dual' ? (
                <IconButton
                  icon="swap-horizontal"
                  size={44}
                  onPress={() => {
                    if (recording) return;
                    setZoom(1);
                    setDualPrimary((p) => (p === 'back' ? 'front' : 'back'));
                  }}
                />
              ) : (
                <IconButton
                  icon="camera-flip-outline"
                  size={44}
                  onPress={() => {
                    if (recording && !canFlipWhileRecording) return;
                    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                    setZoom(1);
                    setLensId(null);
                    setFacing((f) => (f === 'back' ? 'front' : 'back'));
                  }}
                />
              )}
              </View>
            </View>
            <ModeCarousel mode={mode} modes={visibleModes} onChange={changeMode} disabled={recording || busy} proVideo={proVideo} onProVideo={setProVideo} />

          </View>
        </Animated.View>
        {mode === 'night' && ready?.nightExtension && (
          <Animated.View entering={FadeInDown.duration(200)} exiting={FadeOutDown.duration(160)} style={styles.nightReadyWrap}>
            <Glass radius={18} style={styles.nightReady}>
              <MaterialCommunityIcons name="weather-night" size={16} color="#ffd48c" />
              <Text style={styles.nightReadyText}>Night mode ready</Text>
            </Glass>
          </Animated.View>
        )}
      </View>

      <SettingsSheet
        visible={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        captureControls={
          <View style={{ gap: 16 }}>
            <Text style={styles.settingLabel}>Timer</Text>
            <GlassSegmented items={[{ key: '0', label: 'Off' }, { key: '3', label: '3 seconds' }, { key: '10', label: '10 seconds' }]}
              value={String(timer)} onChange={(v) => setTimer(Number(v) as 0 | 3 | 10)} height={36} />
            <Text style={styles.settingLabel}>{isVideoMode ? 'Video light' : 'Flash'}</Text>
            <GlassSegmented items={(isVideoMode ? ['off', 'on'] : ['off', 'auto', 'on']).map((key) => ({ key, label: key[0].toUpperCase() + key.slice(1) }))}
              value={isVideoMode && flash === 'auto' ? 'off' : flash} onChange={(v) => setFlash(v as Flash)} disabled={ready?.hasFlash === false} height={36} />
            <Text style={styles.settingLabel}>Exposure</Text>
            {mode === 'pro' ? <ProPanel value={manual} onChange={setManual} caps={caps} video={proVideo}
              onToggleVideo={() => !recording && setProVideo((v) => !v)} /> :
              <ToneSliders brightness={brightness} shadows={shadows} showShadows={isPhotoShot} onBrightness={setBrightness} onShadows={setShadows} />}
            <Text style={styles.settingLabel}>Filters and skin</Text>
            <LookPanel filter={filter} onFilter={setFilter} smoothing={captureSmoothing(mode, photoSmoothing, smoothing)}
              onSmoothing={mode === 'photo' || mode === 'portrait' ? setPhotoSmoothing : setSmoothing}
              blur={mode === 'portrait' ? bokeh : undefined} onBlur={setBokeh} />
          </View>
        }
        photo={photo}
        video={video}
        onPhoto={setPhoto}
        onVideo={setVideo}
        supportsVideoHdr={!!caps?.cameras.some((c) => c.position === facing && c.videoHdr)}
        bottomInset={insets.bottom}
        mirrorSelfie={mirrorSelfie}
        onMirrorSelfie={setMirrorSelfie}
        palmShutter={palmShutter}
        onPalmShutter={setPalmShutter}
        shutterSound={shutterSound}
        onShutterSound={setShutterSound}
        capabilities={caps}
        remember={remember}
        onRemember={(v) => {
          setRemember(v);
          if (!v) clearSettings();
        }}
        onResetDefaults={() => {
          clearSettings();
          setRemember(false);
          setFlash('off'); setTimer(0);
          setPhoto({ frames: 4, vendorNight: true, highlightBracket: true });
          setVideo({ resolution: '1080p', fps: 30, hdr: false, stabilization: 'cinematic' });
          setMirrorSelfie(true);
          setFilter('natural');
          setPip({ x: 0.74, y: 0.22, size: 0.34 });
          setManual(AUTO_MANUAL);
          setBrightness(0);
          setShadows(0);
          setAspect('4:3');
          flashToast('Settings reset');
        }}
      />
      <Viewer
        visible={viewerOpen}
        onClose={() => setViewerOpen(false)}
        uri={last?.uri}
        originalUri={last?.original}
        isVideo={!!last?.isVideo}
        info={last?.info}
        onOpenGallery={
          last?.assetId
            ? () => {
                setViewerOpen(false);
                openMedia(last.assetId!, last.isVideo, galleryPref === 'ask');
              }
            : undefined
        }
      />
      </>}
      {screens.onSecondary && <>
        {focus && <FocusRing key={focus.key} x={focus.x} y={focus.y} />}
        <RearCameraControls mode={mode} modes={visibleModes} video={isVideoMode} recording={recording} paused={paused}
          busy={busy || countdown > 0 || screens.switching} locked={recording || busy || processing || countdown > 0 || screens.switching}
          countdown={countdown} stops={stops} zoomLabel={trim(shownZoom)} toast={toast} onGallery={openLast}
          skin={captureSmoothing(mode,photoSmoothing,smoothing)} onSkin={mode==='photo'||mode==='portrait'?setPhotoSmoothing:setSmoothing} onShutter={onShutter} onMode={changeMode}
          onLens={(lens) => { if (lens.lensId) { setLensId(lens.lensId); setZoom(1); } else { setLensId(null); setZoom(lens.zoom); } }}
          canFlip={!recording || canFlipWhileRecording}
          onFlip={() => { setZoom(1); setLensId(null); setFacing(f => f === 'back' ? 'front' : 'back'); }}
          onPause={async () => { try { if (paused) await cam.current?.resumeRecording(); else await cam.current?.pauseRecording(); } catch { flashToast('Could not change recording state'); } }}
          onScreens={() => screens.move(0, !!screens.status?.shizukuGranted)} />
      </>}
      <CameraScreenPicker screens={screens} locked={recording || busy || processing || countdown > 0} />

    </View>
  );
}

const SUBBAR_MOVE = LinearTransition.duration(300);
/** Shared motion: things that move glide; things that appear fade/scale in */
const GLIDE = LinearTransition.duration(160);

/** Small top-bar control that pops in/out while its neighbours glide aside */
function Pop({ children }: { children: React.ReactNode }) {
  return (
    <Animated.View entering={FadeIn.duration(160)} exiting={FadeOut.duration(120)} layout={GLIDE}>
      {children}
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  instrumentCluster: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 2, height: 48, gap: 2 },
  galleryAnchor: { position: 'absolute', bottom: 14, left: 6, zIndex: 3 },
  flipAnchor: { position: 'absolute', bottom: 14, right: 6, zIndex: 3 },
  settingLabel: { color: '#fff', fontSize: 14, fontWeight: '600' },
  root: { flex: 1, backgroundColor: '#000' },
  center: { alignItems: 'center', justifyContent: 'center' },
  dim: { color: 'rgba(255,255,255,0.6)' },
  top: { position: 'absolute', left: 18, right: 18, alignItems: 'stretch', gap: 10, zIndex: 8 },
  topRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  controlButton: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  topPill: { minWidth: 100, maxWidth: 200, flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 10, height: 44 },
  qualityChip: { minWidth: 48, maxWidth: 78, height: 34, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 2, paddingHorizontal: 3 },
  qualityText: { color: '#fff', fontSize: 12, fontWeight: '600', letterSpacing: 0.2 },
  topMetaRow: { flexDirection: 'row', alignItems: 'center', gap: 7, marginHorizontal: 2 },
  topMetaChip: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 4, minHeight: 24, maxWidth: '70%' },
  statusDot: { width: 4, height: 4, borderRadius: 2, backgroundColor: '#ffe16b' },
  topMetaLabel: { color: 'rgba(255,255,255,0.85)', fontSize: 10, fontWeight: '600', letterSpacing: 1.8, textShadowColor: '#000', textShadowRadius: 4 },
  topMetaTools: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  metaTool: { width: 30, height: 30, alignItems: 'center', justifyContent: 'center' },
  subBar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, paddingHorizontal: 12, height: 34, borderRadius: 18, overflow: 'hidden' },
  recordingBar: { alignSelf: 'center' },
  recLed: { width: 8, height: 8, borderRadius: 4, backgroundColor: '#ff453a' },
  recText: { color: '#fff', fontWeight: '700', fontVariant: ['tabular-nums'] },
  countdown: { color: '#fff', fontSize: 96, fontWeight: '200' },
  bottom: { position: 'absolute', left: 0, right: 0, bottom: 0, gap: 6, zIndex: 8 },
  zoomFloat: { alignSelf: 'center', marginBottom: 4 },
  shutterRow: { height: 72, alignItems: 'center', justifyContent: 'center', position: 'relative' },
  shutterDeck: { alignSelf: 'center', width: '100%', maxWidth: 620, backgroundColor: 'rgba(0,0,0,0.94)', paddingTop: 4, paddingBottom: 2, gap: 4 },
  nightReadyWrap: { alignSelf: 'center', marginTop: -2 },
  nightReady: { flexDirection: 'row', alignItems: 'center', gap: 7, paddingHorizontal: 12, height: 30 },
  nightReadyText: { color: '#fff', fontSize: 11, fontWeight: '700' },
});
