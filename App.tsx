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
  displayZoom,
  formatFilters,
  lensStops,
  pickStabilization,
  profileDevice,
  type CaptureMode,
  type PhotoSettings,
  type VideoSettings,
} from './src/camera/hardware';
import { processBurst } from './src/processing/pipeline';
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
} from './src/ui/Controls';
import { Glass } from './src/ui/Glass';
import { PermissionGate, SettingsSheet, Viewer } from './src/ui/Sheets';

type Flash = 'off' | 'auto' | 'on';
type Last = { uri?: string; original?: string; isVideo: boolean; info?: string };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

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

  const isVideo = mode === 'video' || mode === 'action';

  /* ---------- hardware ---------- */
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
    const want = mode === 'action' ? 60 : isVideo ? video.fps : 30;
    return clamp(want, min, max);
  }, [format, mode, isVideo, video.fps]);

  const stabilization = isVideo
    ? pickStabilization(format, mode === 'action' ? 'cinematic' : video.stabilization)
    : undefined;
  const videoHdr = isVideo && mode === 'video' && video.hdr && !!format?.supportsVideoHdr;
  const photoHdr = !isVideo && photo.nativeHdr && !!format?.supportsPhotoHdr;
  const stops = useMemo(() => lensStops(device), [device]);

  useEffect(() => {
    if (device) setZoom(device.neutralZoom || 1);
  }, [device?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const exposure = device
    ? clamp(captureEv ?? brightness * 2, device.minExposure, device.maxExposure)
    : 0;

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
    },
    [recording, mode],
  );

  /* ---------- capture: photo ---------- */
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

      const res = await processBurst(paths, { night, brightness, shadows });
      if (mediaPerm?.granted) await MediaLibrary.createAssetAsync(res.uri);
      setLast({
        uri: res.uri,
        original,
        isVideo: false,
        info: `${night ? 'Night Sight' : 'HDR+'} · ${res.frames} frame${res.frames > 1 ? 's' : ''} · ${res.width}×${res.height}`,
      });
      flashToast('Saved');
    } catch (e: any) {
      if (paths[0] && mediaPerm?.granted) {
        await MediaLibrary.createAssetAsync(`file://${paths[0]}`).catch(() => {});
      }
      flashToast(`Processing failed — saved original (${String(e?.message ?? e).slice(0, 60)})`, 4000);
    } finally {
      setCaptureEv(null);
      setProcessing(false);
      setBusy(false);
    }
  }, [device, busy, mode, flash, photo.frames, brightness, shadows, mediaPerm, flashToast]);

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
    c.startRecording({
      fileType: 'mp4',
      videoCodec: video.hevc ? 'h265' : 'h264',
      videoBitRate: 'extra-high',
      onRecordingFinished: async (v) => {
        setRecording(false);
        try {
          if (mediaPerm?.granted) await MediaLibrary.createAssetAsync(`file://${v.path}`);
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
  }, [recording, video.hevc, mediaPerm, flashToast]);

  useEffect(() => {
    if (!recording) return;
    const id = setInterval(() => setRecSeconds((s) => s + 1), 1000);
    return () => clearInterval(id);
  }, [recording]);

  const onShutter = useCallback(async () => {
    if (isVideo) return toggleRecording();
    if (timer > 0) {
      for (let t = timer; t > 0; t--) {
        setCountdown(t);
        Haptics.selectionAsync();
        await sleep(1000);
      }
      setCountdown(0);
    }
    return shootPhoto();
  }, [isVideo, timer, toggleRecording, shootPhoto]);

  /* ---------- gestures: tap-to-focus, pinch-to-zoom, swipe modes ---------- */
  const live = useRef({ zoom, device, mode, recording });
  live.current = { zoom, device, mode, recording };
  const gesture = useRef({ pinchStart: 0, zoomStart: 1, pinched: false });

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
          const d = live.current.device;
          if (t.length >= 2 && d) {
            const dist = Math.hypot(t[0].pageX - t[1].pageX, t[0].pageY - t[1].pageY);
            if (!gesture.current.pinchStart) {
              gesture.current.pinchStart = dist;
              gesture.current.zoomStart = live.current.zoom;
            }
            gesture.current.pinched = true;
            const z = gesture.current.zoomStart * (dist / gesture.current.pinchStart);
            setZoom(clamp(z, d.minZoom, Math.min(d.maxZoom, (d.neutralZoom || 1) * 20)));
          }
        },
        onPanResponderRelease: (e, g) => {
          if (gesture.current.pinched) return;
          if (Math.abs(g.dx) < 10 && Math.abs(g.dy) < 10) {
            const { locationX: x, locationY: y } = e.nativeEvent;
            setFocus({ x, y, key: Date.now() });
            pokeSliders();
            if (live.current.device?.supportsFocus) cam.current?.focus({ x, y }).catch(() => {});
          } else if (Math.abs(g.dx) > 70 && Math.abs(g.dx) > Math.abs(g.dy) * 1.5 && !live.current.recording) {
            const idx = MODES.findIndex((m) => m.key === live.current.mode);
            const next = MODES[clamp(idx + (g.dx < 0 ? 1 : -1), 0, MODES.length - 1)];
            changeModeRef.current(next.key);
          }
        },
      }),
    [pokeSliders],
  );
  const changeModeRef = useRef(changeMode);
  changeModeRef.current = changeMode;

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

  return (
    <View style={styles.root}>
      <StatusBar style="light" hidden />

      {device ? (
        <Camera
          ref={cam}
          style={StyleSheet.absoluteFill}
          device={device}
          isActive={appActive && !viewerOpen}
          photo={!isVideo}
          video={isVideo}
          audio={isVideo && micPerm.hasPermission}
          format={format}
          fps={fps}
          zoom={zoom}
          exposure={exposure}
          torch={isVideo && flash === 'on' && device.hasTorch ? 'on' : 'off'}
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
          <Pressable
            hitSlop={8}
            onPress={() => setFlash((f) => (f === 'off' ? 'auto' : f === 'auto' ? 'on' : 'off'))}
            disabled={!device?.hasFlash && !device?.hasTorch}
          >
            <MaterialCommunityIcons name={flashIcon} size={22} color={device?.hasFlash ? '#fff' : 'rgba(255,255,255,0.35)'} />
          </Pressable>
          {!isVideo && (
            <Pressable hitSlop={8} onPress={() => setTimer((t) => (t === 0 ? 3 : t === 3 ? 10 : 0))}>
              <MaterialCommunityIcons name={timerIcon} size={22} color="#fff" />
            </Pressable>
          )}
          {isVideo ? (
            <Pressable
              hitSlop={8}
              onPress={() =>
                mode === 'video' &&
                setVideo((v) => ({ ...v, resolution: v.resolution === '4k' ? '1080p' : '4k' }))
              }
            >
              <Text style={styles.badge}>
                {mode === 'action' ? 'ACTION' : video.resolution === '4k' ? '4K' : '1080p'} · {fps}
                {videoHdr ? ' · HDR' : ''}
              </Text>
            </Pressable>
          ) : (
            <Text style={styles.badge}>{mode === 'night' ? 'NIGHT' : 'HDR+'}</Text>
          )}
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
        {showSliders && (
          <ToneSliders
            brightness={brightness}
            shadows={shadows}
            showShadows={!isVideo}
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
          zoom={zoom}
          label={displayZoom(device, zoom)}
          onSelect={(z) => {
            Haptics.selectionAsync();
            setZoom(z);
          }}
        />
        <ModeCarousel mode={mode} onChange={changeMode} disabled={recording} />
        <View style={styles.shutterRow}>
          <Thumb uri={last?.uri} processing={processing} onPress={() => setViewerOpen(true)} />
          <Shutter mode={mode} recording={recording} busy={busy || countdown > 0} onPress={onShutter} />
          <IconButton
            icon="camera-flip-outline"
            size={56}
            onPress={() => {
              if (recording) return;
              Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
              setFacing((f) => (f === 'back' ? 'front' : 'back'));
            }}
          />
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
  topPill: { flexDirection: 'row', alignItems: 'center', gap: 18, paddingHorizontal: 16, height: 44 },
  badge: { color: '#fff', fontSize: 12, fontWeight: '800', letterSpacing: 0.6 },
  recBadge: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 12, height: 32 },
  recLed: { width: 8, height: 8, borderRadius: 4, backgroundColor: '#fff' },
  recText: { color: '#fff', fontWeight: '700', fontVariant: ['tabular-nums'] },
  countdown: { color: '#fff', fontSize: 96, fontWeight: '200' },
  bottom: { position: 'absolute', left: 0, right: 0, bottom: 0, gap: 14 },
  shutterRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 36 },
});
