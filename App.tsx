import { MaterialCommunityIcons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import * as MediaLibrary from 'expo-media-library';
import { StatusBar } from 'expo-status-bar';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AppState, PanResponder, PermissionsAndroid, Pressable, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import { SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  cameraModuleAvailable,
  detectFaces,
  getCapabilities,
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
import { filterByKey, type FilterKey } from './src/processing/filters';
import { processBurst, processSingle, type PhotoMeta } from './src/processing/pipeline';
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
} from './src/ui/Controls';
import { clearSettings, loadSettings, saveSettings } from './src/settings';
import { DualPipFrame } from './src/ui/DualPip';
import { ErrorBoundary } from './src/ui/ErrorBoundary';
import { Glass } from './src/ui/Glass';
import { AUTO_MANUAL, LookPanel, ProPanel, type ManualSettings } from './src/ui/ProPanel';
import { PermissionGate, SettingsSheet, Viewer } from './src/ui/Sheets';

type Flash = 'off' | 'auto' | 'on';
type Last = { uri?: string; original?: string; isVideo: boolean; info?: string };
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
    hdr: true,
    stabilization: 'cinematic',
  });
  const [mirrorSelfie, setMirrorSelfie] = useState(true);
  const [filter, setFilter] = useState<FilterKey>('natural');
  const [smoothing, setSmoothing] = useState(0);
  const [showLook, setShowLook] = useState(false);
  const [manual, setManual] = useState<ManualSettings>(AUTO_MANUAL);
  const [proVideo, setProVideo] = useState(false);
  const [dualPrimary, setDualPrimary] = useState<'back' | 'front'>('back');
  const [caps, setCaps] = useState<Capabilities | null>(null);
  const [ready, setReady] = useState<ReadyEvent | null>(null);
  const [pip, setPip] = useState({ x: 0.74, y: 0.22, size: 0.34 });
  const [aspect, setAspect] = useState<Aspect>('4:3');
  const win = useWindowDimensions();
  const [remember, setRemember] = useState(false);
  const [settingsLoaded, setSettingsLoaded] = useState(false);

  const [busy, setBusy] = useState(false);
  const [processing, setProcessing] = useState(false);
  const [recording, setRecording] = useState(false);
  const [recSeconds, setRecSeconds] = useState(0);
  const [countdown, setCountdown] = useState(0);
  const [last, setLast] = useState<Last | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [focus, setFocus] = useState<{ x: number; y: number; key: number } | null>(null);
  const [showSliders, setShowSliders] = useState(false);
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
    pip: typeof pip;
    manual: ManualSettings;
    brightness: number;
    shadows: number;
    aspect: Aspect;
  };
  useEffect(() => {
    loadSettings<Saved>().then((v) => {
      if (v?.remember) {
        setRemember(true);
        if (v.photo) setPhoto((p) => ({ ...p, ...v.photo }));
        if (v.video) setVideo((x) => ({ ...x, ...v.video }));
        if (v.mode) setMode(v.mode);
        if (typeof v.mirrorSelfie === 'boolean') setMirrorSelfie(v.mirrorSelfie);
        if (v.filter) setFilter(v.filter);
        if (typeof v.smoothing === 'number') setSmoothing(v.smoothing);
        if (v.pip) setPip(v.pip);
        if (v.manual) setManual(v.manual);
        if (typeof v.brightness === 'number') setBrightness(v.brightness);
        if (typeof v.shadows === 'number') setShadows(v.shadows);
        if (v.aspect) setAspect(v.aspect);
      }
      setSettingsLoaded(true);
    });
  }, []);
  useEffect(() => {
    if (!settingsLoaded) return;
    if (!remember) return;
    const t = setTimeout(
      () => saveSettings({ remember, mode, photo, video, mirrorSelfie, filter, smoothing, pip, manual, brightness, shadows, aspect }),
      400,
    );
    return () => clearTimeout(t);
  }, [settingsLoaded, remember, mode, photo, video, mirrorSelfie, filter, smoothing, pip, manual, brightness, shadows, aspect]);

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
    mode === 'night' ? 'night' : mode === 'photo' ? 'photo' : mode === 'pro' && !proVideo ? 'photo' : 'video';
  const isPhotoShot = shutterKind !== 'video';
  const isVideoMode = VIDEO_MODES.includes(mode) || (mode === 'pro' && proVideo);

  const visibleModes = useMemo(
    () =>
      MODES.filter((m) => {
        if (m.key === 'slowmo') return !!caps?.slowMotion;
        if (m.key === 'dual') return !!caps?.concurrent;
        return true;
      }),
    [caps],
  );

  const stops = useMemo(() => lensStops(zoomRange.min, zoomRange.max), [zoomRange]);
  // Output width/height (portrait) for the chosen aspect; 'full' matches the screen
  const aspectRatio = aspect === '4:3' ? 3 / 4 : aspect === '16:9' ? 9 / 16 : aspect === '1:1' ? 1 : win.width / win.height;

  /* ---------- helpers ---------- */
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flashToast = useCallback((t: string, ms = 2200) => {
    setToast(t);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), ms);
  }, []);

  const sliderTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pokeSliders = useCallback(() => {
    setShowSliders(true);
    if (sliderTimer.current) clearTimeout(sliderTimer.current);
    sliderTimer.current = setTimeout(() => setShowSliders(false), 4500);
  }, []);

  const changeMode = useCallback(
    (m: CaptureMode) => {
      if (recording || m === mode) return;
      Haptics.selectionAsync();
      setMode(m);
      setShowSliders(false);
      if (VIDEO_MODES.includes(m)) setShowLook(false);
    },
    [recording, mode],
  );

  const saveToGallery = useCallback(
    async (uri: string) => {
      if (perms.media) await MediaLibrary.createAssetAsync(uri);
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
  const shootPhoto = useCallback(async () => {
    if (busy || !ready) return;
    const night = mode === 'night';
    const pro = mode === 'pro';
    const vendorNight = night && ready.nightExtension;
    const frames = pro || vendorNight || flash !== 'off' ? 1 : night ? 4 : photo.frames;
    const evShift = night ? 0 : -1; // HDR+ under-exposes the burst to protect highlights

    setBusy(true);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    let paths: string[] = [];
    try {
      // Photo mode adds one darker frame (-2 EV below the burst) for highlight recovery
      const bracket = !night && frames > 1 && photo.highlightBracket ? -2 : 0;
      const res = await captureBurst(frames, frames > 1 ? evShift : 0, bracket);
      paths = res.paths;
      if (!paths.length) throw new Error(res.error ?? 'No photo captured');

      const original = `file://${paths[0]}`;
      setLast({ uri: original, original, isVideo: false });
      setProcessing(true);
      await sleep(16);

      let uri: string;
      let info: string;
      const look = [filter !== 'natural' && filterByKey(filter).label, smoothing > 0.01 && 'smoothed']
        .filter(Boolean)
        .join(' · ');
      if (pro || vendorNight) {
        // Already processed by the camera (manual or vendor night) – only apply the look
        uri = await processSingle(paths[0], smoothing, filter, aspectRatio, res.meta?.[0]);
        info = pro ? 'Pro' : 'Night Sight (phone)';
      } else {
        setToast(night ? `Night Sight · merging ${paths.length} frames` : `HDR+ · merging ${paths.length} frame${paths.length > 1 ? 's' : ''}`);
        const faces = await detectFaces(paths[0]);
        const out = await processBurst(paths, {
          night,
          brightness,
          shadows,
          smoothing,
          filter,
          evs: res.evs,
          shortIndex: res.shortIndex ?? -1,
          faces,
          meta: res.meta,
          aspect: aspectRatio,
        });
        uri = out.uri;
        info = `${night ? 'Night Sight' : 'HDR+'} · ${out.frames} frame${out.frames > 1 ? 's' : ''}${faces.length ? ` · ${faces.length} face${faces.length > 1 ? 's' : ''}` : ''}`;
      }
      await saveToGallery(uri);
      setLast({ uri, original, isVideo: false, info: look ? `${info} · ${look}` : info });
      flashToast('Saved');
    } catch (e: any) {
      if (paths[0]) await saveToGallery(`file://${paths[0]}`).catch(() => {});
      flashToast(`${paths[0] ? 'Saved original — ' : ''}${String(e?.message ?? e).slice(0, 80)}`, 4000);
    } finally {
      setProcessing(false);
      setBusy(false);
    }
  }, [busy, ready, mode, flash, photo.frames, photo.highlightBracket, brightness, shadows, smoothing, filter, aspectRatio, captureBurst, saveToGallery, flashToast]);

  /* ---------- capture: video ---------- */
  const toggleRecording = useCallback(async () => {
    const c = cam.current;
    if (!c) return;
    if (recording) {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      await c.stopRecording();
      return;
    }
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy);
    setRecSeconds(0);
    setRecording(true);
    await c.startRecording().catch((e) => {
      setRecording(false);
      flashToast(String(e?.message ?? e), 4000);
    });
  }, [recording, flashToast]);

  useEffect(() => {
    if (!recording) return;
    const id = setInterval(() => setRecSeconds((s) => s + 1), 1000);
    return () => clearInterval(id);
  }, [recording]);

  const onShutter = useCallback(async () => {
    if (isVideoMode) return toggleRecording();
    if (timer > 0) {
      for (let t = timer; t > 0; t--) {
        setCountdown(t);
        Haptics.selectionAsync();
        await sleep(1000);
      }
      setCountdown(0);
    }
    return shootPhoto();
  }, [isVideoMode, timer, toggleRecording, shootPhoto]);

  /* ---------- exposure +/- (1/3 EV steps, every mode) ---------- */
  const nudgeExposure = useCallback(
    (dir: 1 | -1) => {
      Haptics.selectionAsync();
      if (mode === 'pro') {
        const ev = clamp(Math.round((manual.ev + dir / 3) * 3) / 3, -2, 2);
        setManual({ ...manual, ev });
        flashToast(`Exposure ${ev > 0 ? '+' : ''}${ev.toFixed(1)} EV`, 1200);
      } else {
        // brightness ±1 maps to ±2 EV, so 1/3 EV = 1/6 brightness
        const b = clamp(Math.round((brightness + dir / 6) * 6) / 6, -1, 1);
        setBrightness(b);
        const ev = b * 2;
        flashToast(`Exposure ${ev > 0 ? '+' : ''}${ev.toFixed(1)} EV`, 1200);
      }
    },
    [mode, manual, brightness, flashToast],
  );

  /* ---------- gestures: tap-to-focus, pinch-to-zoom, swipe modes ---------- */
  const live = useRef({ zoom, zoomRange, mode, recording, visibleModes });
  live.current = { zoom, zoomRange, mode, recording, visibleModes };
  const gesture = useRef({ pinchStart: 0, zoomStart: 1, pinched: false });
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
          const { min, max } = live.current.zoomRange;
          setZoom(clamp(gesture.current.zoomStart * (dist / gesture.current.pinchStart), min, Math.min(max, 20)));
        },
        onPanResponderRelease: (e, g) => {
          if (gesture.current.pinched) return;
          const L = live.current;
          if (Math.abs(g.dx) < 10 && Math.abs(g.dy) < 10) {
            const { locationX: x, locationY: y } = e.nativeEvent;
            setFocus({ x, y, key: Date.now() });
            cam.current?.focus(x, y).catch(() => {});
            if (L.mode !== 'pro') pokeSliders();
          } else if (Math.abs(g.dx) > 70 && Math.abs(g.dx) > Math.abs(g.dy) * 1.5 && !L.recording) {
            const list = L.visibleModes;
            const idx = list.findIndex((m) => m.key === L.mode);
            const next = list[clamp(idx + (g.dx < 0 ? 1 : -1), 0, list.length - 1)];
            changeModeRef.current(next.key);
          }
        },
      }),
    [pokeSliders],
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

  const flashIcon = flash === 'on' ? 'flash' : flash === 'auto' ? 'flash-auto' : 'flash-off';
  const timerIcon = timer === 3 ? 'timer-3' : timer === 10 ? 'timer-10' : 'timer-off-outline';
  const mm = String(Math.floor(recSeconds / 60)).padStart(2, '0');
  const ss = String(recSeconds % 60).padStart(2, '0');

  const badge =
    mode === 'night'
      ? ready?.nightExtension
        ? 'NIGHT · PHONE'
        : 'NIGHT'
      : mode === 'photo'
        ? 'HDR+'
        : mode === 'pro'
          ? proVideo
            ? 'PRO VIDEO'
            : 'PRO'
          : mode === 'slowmo'
            ? `SLO-MO${ready?.slowMotionFps ? ` · ${ready.slowMotionFps}` : ''}`
            : mode === 'dual'
              ? 'DUAL'
              : mode === 'action'
                ? 'ACTION · 60'
                : `${video.resolution === '4k' ? '4K' : '1080p'} · ${video.fps}${video.hdr ? ' · HDR' : ''}`;

  return (
    <View style={styles.root}>
      <StatusBar style="light" hidden />

      {cameraModuleAvailable ? (
        <ICameraView
          ref={cam}
          style={StyleSheet.absoluteFill}
          mode={mode}
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
          audio={perms.mic}
          active={appActive && !viewerOpen}
          videoQuality={video.resolution === '4k' ? 'uhd' : 'fhd'}
          fps={video.fps}
          hdrVideo={video.hdr}
          stabilization={video.stabilization}
          nightExtension={photo.vendorNight}
          dualPip={pip}
          aspect={aspect === '16:9' || aspect === 'full' ? '16:9' : '4:3'}
          previewFit={isPhotoShot && aspect !== 'full'}
          onReady={(e) => {
            const r = e.nativeEvent;
            setReady(r);
            setZoomRange({ min: r.zoomMin, max: r.zoomMax });
            setZoom((z) => clamp(z, r.zoomMin, r.zoomMax));
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
          onRecordingFinished={async (e) => {
            setRecording(false);
            const { path, durationMs, slowMotion, error } = e.nativeEvent;
            if (!path) {
              flashToast(error ?? 'Recording failed', 4000);
              return;
            }
            try {
              await saveToGallery(`file://${path}`);
              setLast({
                isVideo: true,
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

      <View style={StyleSheet.absoluteFill} {...responder.panHandlers} />
      {isPhotoShot && aspect === '1:1' && (() => {
        // Letterboxed 3:4 preview; shade the parts outside the square crop
        const areaH = Math.min(win.height, (win.width * 4) / 3);
        const top = (win.height - areaH) / 2;
        const bar = (areaH - win.width) / 2;
        return (
          <>
            <View pointerEvents="none" style={[styles.cropBar, { top, height: bar }]} />
            <View pointerEvents="none" style={[styles.cropBar, { top: top + areaH - bar, height: bar }]} />
          </>
        );
      })()}
      {focus && <FocusRing key={focus.key} x={focus.x} y={focus.y} />}

      {/* Top bar */}
      <View style={[styles.top, { top: insets.top + 10 }]} pointerEvents="box-none">
        <Glass radius={24} style={styles.topPill}>
          <Pressable hitSlop={8} onPress={() => setFlash((f) => (f === 'off' ? 'auto' : f === 'auto' ? 'on' : 'off'))}>
            <MaterialCommunityIcons name={flashIcon} size={22} color={ready?.hasFlash === false ? 'rgba(255,255,255,0.35)' : '#fff'} />
          </Pressable>
          {isPhotoShot && (
            <Pressable hitSlop={8} onPress={() => setTimer((t) => (t === 0 ? 3 : t === 3 ? 10 : 0))}>
              <MaterialCommunityIcons name={timerIcon} size={22} color="#fff" />
            </Pressable>
          )}
          {isPhotoShot && (
            <Pressable hitSlop={8} onPress={() => setShowLook((v) => !v)}>
              <MaterialCommunityIcons
                name="palette-outline"
                size={22}
                color={showLook || filter !== 'natural' || smoothing > 0.01 ? '#ffd76a' : '#fff'}
              />
            </Pressable>
          )}
          {isPhotoShot && (
            <Pressable
              hitSlop={8}
              onPress={() => {
                Haptics.selectionAsync();
                setAspect((a) => ASPECTS[(ASPECTS.indexOf(a) + 1) % ASPECTS.length]);
              }}
            >
              <Text style={styles.aspectChip}>{aspect === 'full' ? 'FULL' : aspect}</Text>
            </Pressable>
          )}
          {facing === 'front' && mode !== 'dual' && (
            <Pressable hitSlop={8} onPress={() => setMirrorSelfie((v) => !v)}>
              <MaterialCommunityIcons name="flip-horizontal" size={22} color={mirrorSelfie ? '#ffd76a' : '#fff'} />
            </Pressable>
          )}
          <Pressable
            hitSlop={8}
            onPress={() =>
              mode === 'video' && setVideo((v) => ({ ...v, resolution: v.resolution === '4k' ? '1080p' : '4k' }))
            }
          >
            <Text style={styles.badge}>{badge}</Text>
          </Pressable>
        </Glass>
        {recording ? (
          <Glass radius={18} style={styles.recBadge} tint="rgba(255,59,48,0.55)">
            <View style={styles.recLed} />
            <Text style={styles.recText}>
              {mm}:{ss}
            </Text>
          </Glass>
        ) : null}
        <IconButton icon="cog-outline" onPress={() => setSettingsOpen(true)} />
      </View>

      {mode === 'dual' && (
        <DualPipFrame
          pip={pip}
          locked={recording}
          onMove={(x, y) => setPip((p) => ({ ...p, x, y }))}
          onSwap={() => {
            if (recording) return;
            Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
            setDualPrimary((p) => (p === 'back' ? 'front' : 'back'));
          }}
        />
      )}

      {countdown > 0 && (
        <View style={[StyleSheet.absoluteFill, styles.center]} pointerEvents="none">
          <Text style={styles.countdown}>{countdown}</Text>
        </View>
      )}

      {/* Bottom controls */}
      <View style={[styles.bottom, { paddingBottom: insets.bottom + 14 }]} pointerEvents="box-none">
        <Toast text={toast} />
        {showLook && isPhotoShot && (
          <LookPanel filter={filter} onFilter={setFilter} smoothing={smoothing} onSmoothing={setSmoothing} />
        )}
        {mode === 'pro' && !showLook && (
          <ProPanel
            value={manual}
            onChange={setManual}
            caps={caps}
            video={proVideo}
            onToggleVideo={() => !recording && setProVideo((v) => !v)}
          />
        )}
        {showSliders && mode !== 'pro' && (
          <ToneSliders
            brightness={brightness}
            shadows={shadows}
            showShadows={isPhotoShot}
            onBrightness={(v) => {
              setBrightness(v);
              pokeSliders();
            }}
            onShadows={(v) => {
              setShadows(v);
              pokeSliders();
            }}
          />
        )}
        <View style={styles.zoomRow}>
          <IconButton icon="minus" size={40} onPress={() => nudgeExposure(-1)} />
          <ZoomPills
            stops={stops}
            zoom={zoom}
            label={trim(zoom)}
            onSelect={(z) => {
              Haptics.selectionAsync();
              setZoom(z);
            }}
          />
          <IconButton icon="plus" size={40} onPress={() => nudgeExposure(1)} />
        </View>
        <Glass radius={34} style={styles.dock}>
          <ModeCarousel mode={mode} modes={visibleModes} onChange={changeMode} disabled={recording} />
          <View style={styles.shutterRow}>
            <Thumb uri={last?.uri} processing={processing} onPress={() => setViewerOpen(true)} />
            <Shutter kind={shutterKind} recording={recording} busy={busy || countdown > 0} onPress={onShutter} />
            {mode === 'dual' ? (
              <IconButton
                icon="swap-horizontal"
                size={56}
                onPress={() => !recording && setDualPrimary((p) => (p === 'back' ? 'front' : 'back'))}
              />
            ) : (
              <IconButton
                icon="camera-flip-outline"
                size={56}
                onPress={() => {
                  if (recording) return;
                  Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                  setFacing((f) => (f === 'back' ? 'front' : 'back'));
                }}
              />
            )}
          </View>
        </Glass>
      </View>

      <SettingsSheet
        visible={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        photo={photo}
        video={video}
        onPhoto={setPhoto}
        onVideo={setVideo}
        supportsVideoHdr={!!caps?.cameras.some((c) => c.position === facing && c.videoHdr)}
        bottomInset={insets.bottom}
        mirrorSelfie={mirrorSelfie}
        onMirrorSelfie={setMirrorSelfie}
        capabilities={caps}
        remember={remember}
        onRemember={(v) => {
          setRemember(v);
          if (!v) clearSettings();
        }}
        onResetDefaults={() => {
          clearSettings();
          setRemember(false);
          setPhoto({ frames: 4, vendorNight: true, highlightBracket: true });
          setVideo({ resolution: '1080p', fps: 30, hdr: true, stabilization: 'cinematic' });
          setMirrorSelfie(true);
          setFilter('natural');
          setSmoothing(0);
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
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#000' },
  center: { alignItems: 'center', justifyContent: 'center' },
  dim: { color: 'rgba(255,255,255,0.6)' },
  top: { position: 'absolute', left: 16, right: 16, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  topPill: { flexDirection: 'row', alignItems: 'center', gap: 16, paddingHorizontal: 16, height: 44 },
  badge: { color: '#fff', fontSize: 12, fontWeight: '800', letterSpacing: 0.6 },
  recBadge: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 12, height: 32 },
  recLed: { width: 8, height: 8, borderRadius: 4, backgroundColor: '#fff' },
  recText: { color: '#fff', fontWeight: '700', fontVariant: ['tabular-nums'] },
  countdown: { color: '#fff', fontSize: 96, fontWeight: '200' },
  bottom: { position: 'absolute', left: 0, right: 0, bottom: 0, gap: 12 },
  shutterRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 18 },
  dock: { marginHorizontal: 14, paddingTop: 12, paddingBottom: 18, gap: 18 },
  cropBar: { position: 'absolute', left: 0, right: 0, backgroundColor: 'rgba(0,0,0,0.55)' },
  aspectChip: { color: '#fff', fontSize: 12, fontWeight: '800', borderWidth: 1.5, borderColor: '#fff', borderRadius: 6, paddingHorizontal: 5, paddingVertical: 1 },
  zoomRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 22 },
});
