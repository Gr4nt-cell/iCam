import { MaterialCommunityIcons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import * as MediaLibrary from 'expo-media-library';
import { StatusBar } from 'expo-status-bar';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AppState, PanResponder, Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  Camera,
  useCameraDevice,
  useCameraDevices,
  useCameraFormat,
  useCameraPermission,
  useMicrophonePermission,
} from 'react-native-vision-camera';
import {
  getProCapabilities,
  ProCameraView,
  type ProCameraHandle,
  type ProCapabilities,
} from './modules/pro-camera';
import {
  displayZoom,
  formatFilters,
  lensStops,
  NATIVE_MODES,
  pickStabilization,
  profileDevice,
  type CaptureMode,
  type Lens,
  type PhotoSettings,
  type VideoSettings,
} from './src/camera/hardware';
import { filterByKey, type FilterKey } from './src/processing/filters';
import { processBurst, processSingle } from './src/processing/pipeline';
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
import { Glass } from './src/ui/Glass';
import { AUTO_MANUAL, LookPanel, ProPanel, type ManualSettings } from './src/ui/ProPanel';
import { PermissionGate, SettingsSheet, Viewer } from './src/ui/Sheets';

type Flash = 'off' | 'auto' | 'on';
type Last = { uri?: string; original?: string; isVideo: boolean; info?: string };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const NATIVE_ZOOM_STOPS: Lens[] = [
  { label: '1', zoom: 1 },
  { label: '2', zoom: 2 },
  { label: '5', zoom: 5 },
];

export default function App() {
  return (
    <SafeAreaProvider>
      <CameraScreen />
    </SafeAreaProvider>
  );
}

function CameraScreen() {
  const insets = useSafeAreaInsets();
  const cam = useRef<Camera>(null);
  const pro = useRef<ProCameraHandle>(null);

  /* ---------- permissions ---------- */
  const camPerm = useCameraPermission();
  const micPerm = useMicrophonePermission();
  const [mediaPerm, requestMedia] = MediaLibrary.usePermissions({ granularPermissions: ['photo', 'video'] });

  const requestAll = useCallback(async () => {
    if (!camPerm.hasPermission) await camPerm.requestPermission();
    if (!micPerm.hasPermission) await micPerm.requestPermission();
    if (!mediaPerm?.granted) await requestMedia();
  }, [camPerm, micPerm, mediaPerm, requestMedia]);

  useEffect(() => {
    requestAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* ---------- state ---------- */
  const [mode, setMode] = useState<CaptureMode>('photo');
  const [facing, setFacing] = useState<'back' | 'front'>('back');
  const [flash, setFlash] = useState<Flash>('off');
  const [timer, setTimer] = useState<0 | 3 | 10>(0);
  const [zoom, setZoom] = useState(1);
  const [proZoom, setProZoom] = useState(1);
  const [brightness, setBrightness] = useState(0);
  const [shadows, setShadows] = useState(0);
  const [captureEv, setCaptureEv] = useState<number | null>(null);
  const [photo, setPhoto] = useState<PhotoSettings>({ frames: 4, nativeHdr: false });
  const [video, setVideo] = useState<VideoSettings>({
    resolution: '4k',
    fps: 30,
    hevc: true,
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
  const [caps, setCaps] = useState<ProCapabilities | null>(null);
  const [vcHold, setVcHold] = useState(false);

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

  useEffect(() => {
    const sub = AppState.addEventListener('change', (s) => setAppActive(s === 'active'));
    return () => sub.remove();
  }, []);

  useEffect(() => {
    if (!camPerm.hasPermission) return;
    getProCapabilities()
      .then(setCaps)
      .catch(() => setCaps(null));
  }, [camPerm.hasPermission]);

  const isNative = NATIVE_MODES.includes(mode);
  const isVcVideo = mode === 'video' || mode === 'action';
  const shutterKind: ShutterKind =
    mode === 'night' ? 'night' : mode === 'photo' ? 'photo' : mode === 'pro' && !proVideo ? 'photo' : 'video';
  const isPhotoShot = shutterKind !== 'video';

  const visibleModes = useMemo(
    () =>
      MODES.filter((m) => {
        if (m.key === 'slowmo') return !!caps?.slowMotion;
        if (m.key === 'dual') return !!caps?.concurrent;
        if (m.key === 'pro') return caps !== null;
        return true;
      }),
    [caps],
  );

  /* ---------- hardware (VisionCamera) ---------- */
  const back = useCameraDevice('back', {
    physicalDevices: ['ultra-wide-angle-camera', 'wide-angle-camera', 'telephoto-camera'],
  });
  const front = useCameraDevice('front');
  const device = facing === 'back' ? back ?? front : front ?? back;
  const allDevices = useCameraDevices();
  const profiles = useMemo(() => allDevices.map(profileDevice), [allDevices]);

  const filters = useMemo(() => formatFilters(mode, video), [mode, video]);
  const format = useCameraFormat(device, filters);

  const fps = useMemo(() => {
    const max = format?.maxFps ?? 30;
    const min = format?.minFps ?? 1;
    const want = mode === 'action' ? 60 : isVcVideo ? video.fps : 30;
    return clamp(want, min, max);
  }, [format, mode, isVcVideo, video.fps]);

  const stabilization = isVcVideo
    ? pickStabilization(format, mode === 'action' ? 'cinematic' : video.stabilization)
    : undefined;
  const videoHdr = mode === 'video' && video.hdr && !!format?.supportsVideoHdr;
  const photoHdr = !isVcVideo && photo.nativeHdr && !!format?.supportsPhotoHdr;
  const stops = useMemo(() => (isNative ? NATIVE_ZOOM_STOPS : lensStops(device)), [device, isNative]);

  useEffect(() => {
    if (device) setZoom(device.neutralZoom || 1);
  }, [device?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const exposure = device ? clamp(captureEv ?? brightness * 2, device.minExposure, device.maxExposure) : 0;
  const lookAvailable = isPhotoShot;
  const previewFilter = lookAvailable ? filterByKey(filter).preview : undefined;

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
      const leavingNative = NATIVE_MODES.includes(mode) && !NATIVE_MODES.includes(m);
      if (leavingNative) {
        // let CameraX release the sensor before VisionCamera grabs it again
        setVcHold(true);
        setTimeout(() => setVcHold(false), 450);
      }
      setMode(m);
      setShowSliders(false);
      if (m === 'video' || m === 'slowmo' || m === 'dual' || m === 'action') setShowLook(false);
    },
    [recording, mode],
  );

  const saveToGallery = useCallback(
    async (uri: string) => {
      if (mediaPerm?.granted) await MediaLibrary.createAssetAsync(uri);
    },
    [mediaPerm],
  );

  /* ---------- capture: HDR+ photo (VisionCamera) ---------- */
  const shootPhoto = useCallback(async () => {
    const c = cam.current;
    if (!c || !device || busy) return;
    const night = mode === 'night';
    const useFlash = flash !== 'off' && device.hasFlash;
    const frames = useFlash ? 1 : night ? 4 : photo.frames;

    setBusy(true);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    const paths: string[] = [];
    try {
      if (frames > 1) {
        // HDR+ shoots the burst underexposed to protect highlights, then tone-maps shadows up
        const base = brightness * 2;
        setCaptureEv(clamp(night ? base : base - 1, device.minExposure, device.maxExposure));
        await sleep(night ? 450 : 300);
      }
      for (let i = 0; i < frames; i++) {
        const shot = await c.takePhoto({
          flash: i === 0 && useFlash ? flash : 'off',
          enableShutterSound: i === 0,
        });
        paths.push(shot.path);
      }
      setCaptureEv(null);
      const original = `file://${paths[0]}`;
      setLast({ uri: original, original, isVideo: false });
      setProcessing(true);
      setToast(night ? `Night Sight · merging ${frames} frames` : `HDR+ · merging ${frames} frame${frames > 1 ? 's' : ''}`);
      await sleep(16);

      const res = await processBurst(paths, { night, brightness, shadows, smoothing, filter });
      await saveToGallery(res.uri);
      const look = [filter !== 'natural' && filterByKey(filter).label, smoothing > 0.01 && 'smoothed']
        .filter(Boolean)
        .join(' · ');
      setLast({
        uri: res.uri,
        original,
        isVideo: false,
        info: `${night ? 'Night Sight' : 'HDR+'} · ${res.frames} frame${res.frames > 1 ? 's' : ''}${look ? ` · ${look}` : ''}`,
      });
      flashToast('Saved');
    } catch (e: any) {
      if (paths[0]) await saveToGallery(`file://${paths[0]}`).catch(() => {});
      flashToast(`Processing failed — saved original (${String(e?.message ?? e).slice(0, 60)})`, 4000);
    } finally {
      setCaptureEv(null);
      setProcessing(false);
      setBusy(false);
    }
  }, [device, busy, mode, flash, photo.frames, brightness, shadows, smoothing, filter, saveToGallery, flashToast]);

  /* ---------- capture: video (VisionCamera) ---------- */
  const toggleVcRecording = useCallback(async () => {
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
    c.startRecording({
      fileType: 'mp4',
      videoCodec: video.hevc ? 'h265' : 'h264',
      videoBitRate: 'extra-high',
      onRecordingFinished: async (v) => {
        setRecording(false);
        try {
          await saveToGallery(`file://${v.path}`);
          setLast({ isVideo: true, info: `${Math.round(v.duration)} s` });
          flashToast('Video saved');
        } catch {
          flashToast('Could not save video');
        }
      },
      onRecordingError: (e) => {
        setRecording(false);
        flashToast(`Recording failed: ${e.message}`, 4000);
      },
    });
  }, [recording, video.hevc, saveToGallery, flashToast]);

  /* ---------- capture: native CameraX modes ---------- */
  const nativeShutter = useCallback(async () => {
    const p = pro.current;
    if (!p) return;
    if (shutterKind !== 'video') {
      if (busy) return;
      setBusy(true);
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
      await p.takePhoto().catch(() => setBusy(false));
      return;
    }
    if (recording) {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      await p.stopRecording();
    } else {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy);
      setRecSeconds(0);
      setRecording(true);
      await p.startRecording().catch(() => setRecording(false));
    }
  }, [shutterKind, busy, recording]);

  const onProPhoto = useCallback(
    async (path: string) => {
      const original = `file://${path}`;
      try {
        let uri = original;
        if (smoothing > 0.01 || filter !== 'natural') {
          setLast({ uri: original, original, isVideo: false });
          setProcessing(true);
          uri = await processSingle(path, smoothing, filter);
        }
        await saveToGallery(uri);
        setLast({ uri, original, isVideo: false, info: 'Pro' });
        flashToast('Saved');
      } catch (e: any) {
        await saveToGallery(original).catch(() => {});
        flashToast(`Saved original (${String(e?.message ?? e).slice(0, 60)})`, 3500);
      } finally {
        setProcessing(false);
        setBusy(false);
      }
    },
    [smoothing, filter, saveToGallery, flashToast],
  );

  useEffect(() => {
    if (!recording) return;
    const id = setInterval(() => setRecSeconds((s) => s + 1), 1000);
    return () => clearInterval(id);
  }, [recording]);

  const onShutter = useCallback(async () => {
    if (isNative) return nativeShutter();
    if (isVcVideo) return toggleVcRecording();
    if (timer > 0) {
      for (let t = timer; t > 0; t--) {
        setCountdown(t);
        Haptics.selectionAsync();
        await sleep(1000);
      }
      setCountdown(0);
    }
    return shootPhoto();
  }, [isNative, isVcVideo, timer, nativeShutter, toggleVcRecording, shootPhoto]);

  /* ---------- gestures: tap-to-focus, pinch-to-zoom, swipe modes ---------- */
  const live = useRef({ zoom, proZoom, device, mode, recording, isNative, visibleModes });
  live.current = { zoom, proZoom, device, mode, recording, isNative, visibleModes };
  const gesture = useRef({ pinchStart: 0, zoomStart: 1, pinched: false });
  const changeModeRef = useRef(changeMode);
  changeModeRef.current = changeMode;

  const responder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: () => true,
        onPanResponderGrant: () => {
          gesture.current = { pinchStart: 0, zoomStart: 1, pinched: false };
        },
        onPanResponderMove: (e) => {
          const t = e.nativeEvent.touches;
          if (t.length < 2) return;
          const L = live.current;
          const dist = Math.hypot(t[0].pageX - t[1].pageX, t[0].pageY - t[1].pageY);
          if (!gesture.current.pinchStart) {
            gesture.current.pinchStart = dist;
            gesture.current.zoomStart = L.isNative ? L.proZoom : L.zoom;
          }
          gesture.current.pinched = true;
          const z = gesture.current.zoomStart * (dist / gesture.current.pinchStart);
          if (L.isNative) setProZoom(clamp(z, 1, 10));
          else if (L.device) {
            const d = L.device;
            setZoom(clamp(z, d.minZoom, Math.min(d.maxZoom, (d.neutralZoom || 1) * 20)));
          }
        },
        onPanResponderRelease: (e, g) => {
          if (gesture.current.pinched) return;
          const L = live.current;
          if (Math.abs(g.dx) < 10 && Math.abs(g.dy) < 10) {
            const { locationX: x, locationY: y } = e.nativeEvent;
            setFocus({ x, y, key: Date.now() });
            if (!L.isNative) {
              pokeSliders();
              if (L.device?.supportsFocus) cam.current?.focus({ x, y }).catch(() => {});
            }
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
  const missing = [
    !camPerm.hasPermission && 'Camera',
    !micPerm.hasPermission && 'Microphone',
    !mediaPerm?.granted && 'Photos & videos',
  ].filter(Boolean) as string[];

  if (!camPerm.hasPermission) {
    return (
      <>
        <StatusBar style="light" hidden />
        <PermissionGate missing={missing} onGrant={requestAll} />
      </>
    );
  }

  const flashIcon = flash === 'on' ? 'flash' : flash === 'auto' ? 'flash-auto' : 'flash-off';
  const timerIcon = timer === 3 ? 'timer-3' : timer === 10 ? 'timer-10' : 'timer-off-outline';
  const mm = String(Math.floor(recSeconds / 60)).padStart(2, '0');
  const ss = String(recSeconds % 60).padStart(2, '0');
  const previewStyle = [StyleSheet.absoluteFill, previewFilter ? { filter: previewFilter } : null];
  const isMirrored = facing === 'front' ? mirrorSelfie : false;

  const badge =
    mode === 'night'
      ? 'NIGHT'
      : mode === 'photo'
        ? 'HDR+'
        : mode === 'pro'
          ? proVideo
            ? 'PRO VIDEO'
            : 'PRO'
          : mode === 'slowmo'
            ? 'SLO-MO'
            : mode === 'dual'
              ? 'DUAL'
              : mode === 'action'
                ? `ACTION · ${fps}`
                : `${video.resolution === '4k' ? '4K' : '1080p'} · ${fps}${videoHdr ? ' · HDR' : ''}`;

  return (
    <View style={styles.root}>
      <StatusBar style="light" hidden />

      {isNative ? (
        <ProCameraView
          ref={pro}
          style={previewStyle}
          mode={mode as 'pro' | 'slowmo' | 'dual'}
          facing={facing}
          dualPrimary={dualPrimary}
          iso={manual.iso}
          shutterNs={manual.shutterNs}
          whiteBalance={manual.whiteBalance}
          kelvin={manual.kelvin}
          evBias={manual.ev}
          focusDistance={manual.focusDistance}
          zoom={proZoom}
          torch={flash === 'on' && shutterKind === 'video'}
          mirror={mirrorSelfie}
          audio={micPerm.hasPermission}
          active={appActive && !viewerOpen}
          onReady={(e) => {
            if (e.nativeEvent.mode === 'slowmo' && e.nativeEvent.slowMotionFps) {
              flashToast(`Slow motion · ${e.nativeEvent.slowMotionFps} fps`);
            }
          }}
          onError={(e) => {
            setBusy(false);
            flashToast(e.nativeEvent.message, 4000);
          }}
          onPhotoCaptured={(e) => onProPhoto(e.nativeEvent.path)}
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
      ) : device ? (
        <Camera
          ref={cam}
          style={previewStyle}
          device={device}
          isActive={appActive && !viewerOpen && !vcHold}
          photo={!isVcVideo}
          video={isVcVideo}
          audio={isVcVideo && micPerm.hasPermission}
          format={format}
          fps={fps}
          zoom={zoom}
          exposure={exposure}
          isMirrored={isMirrored}
          torch={isVcVideo && flash === 'on' && device.hasTorch ? 'on' : 'off'}
          lowLightBoost={mode === 'night' && device.supportsLowLightBoost}
          videoHdr={videoHdr}
          photoHdr={photoHdr}
          videoStabilizationMode={stabilization}
          photoQualityBalance="speed"
          outputOrientation="device"
          androidPreviewViewType="texture-view"
          enableZoomGesture={false}
          resizeMode="cover"
          onError={(e) => flashToast(`Camera: ${e.message}`, 4000)}
        />
      ) : (
        <View style={[StyleSheet.absoluteFill, styles.center]}>
          <Text style={styles.dim}>No camera found on this device</Text>
        </View>
      )}

      <View style={StyleSheet.absoluteFill} {...responder.panHandlers} />
      {focus && <FocusRing key={focus.key} x={focus.x} y={focus.y} />}

      {/* Top bar */}
      <View style={[styles.top, { top: insets.top + 10 }]} pointerEvents="box-none">
        <Glass radius={24} style={styles.topPill}>
          <Pressable hitSlop={8} onPress={() => setFlash((f) => (f === 'off' ? 'auto' : f === 'auto' ? 'on' : 'off'))}>
            <MaterialCommunityIcons name={flashIcon} size={22} color="#fff" />
          </Pressable>
          {!isNative && !isVcVideo && (
            <Pressable hitSlop={8} onPress={() => setTimer((t) => (t === 0 ? 3 : t === 3 ? 10 : 0))}>
              <MaterialCommunityIcons name={timerIcon} size={22} color="#fff" />
            </Pressable>
          )}
          {lookAvailable && (
            <Pressable hitSlop={8} onPress={() => setShowLook((v) => !v)}>
              <MaterialCommunityIcons
                name="palette-outline"
                size={22}
                color={showLook || filter !== 'natural' || smoothing > 0.01 ? '#ffd76a' : '#fff'}
              />
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

      {countdown > 0 && (
        <View style={[StyleSheet.absoluteFill, styles.center]} pointerEvents="none">
          <Text style={styles.countdown}>{countdown}</Text>
        </View>
      )}

      {/* Bottom controls */}
      <View style={[styles.bottom, { paddingBottom: insets.bottom + 14 }]} pointerEvents="box-none">
        <Toast text={toast} />
        {showLook && lookAvailable && (
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
        {showSliders && !isNative && (
          <ToneSliders
            brightness={brightness}
            shadows={shadows}
            showShadows={!isVcVideo}
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
        <ZoomPills
          stops={stops}
          zoom={isNative ? proZoom : zoom}
          label={isNative ? (Math.round(proZoom * 10) / 10).toString() : displayZoom(device, zoom)}
          onSelect={(z) => {
            Haptics.selectionAsync();
            if (isNative) setProZoom(z);
            else setZoom(z);
          }}
        />
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
      </View>

      <SettingsSheet
        visible={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        photo={photo}
        video={video}
        onPhoto={setPhoto}
        onVideo={setVideo}
        profiles={profiles}
        supportsVideoHdr={!!device?.formats.some((f) => f.supportsVideoHdr)}
        supportsPhotoHdr={!!device?.formats.some((f) => f.supportsPhotoHdr)}
        bottomInset={insets.bottom}
        mirrorSelfie={mirrorSelfie}
        onMirrorSelfie={setMirrorSelfie}
        capabilities={caps}
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
  shutterRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 36 },
});
