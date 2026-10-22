import { MaterialCommunityIcons } from '@expo/vector-icons';
import React, { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Animated,
  Image,
  PanResponder,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import * as Haptics from 'expo-haptics';
import type { CaptureMode, Lens } from '../camera/hardware';
import { Glass, GlassCircle } from './Glass';
import { GlassSegmented } from './GlassSegmented';

export const MODES: { key: CaptureMode; label: string }[] = [
  { key: 'night', label: 'Night Sight' },
  { key: 'pro', label: 'Pro' },
  { key: 'photo', label: 'Photo' },
  { key: 'portrait', label: 'Portrait' },
  { key: 'macro', label: 'Macro' },
  { key: 'video', label: 'Video' },
  { key: 'slowmo', label: 'Slo-mo' },
  { key: 'dual', label: 'Dual' },
  { key: 'action', label: 'Action' },
];

export type ShutterKind = 'photo' | 'night' | 'video';

/* ---------------- Zoom pills ---------------- */

const PX_PER_LOG = 110; // dial pixels per e-fold of zoom

export function ZoomPills({
  stops,
  zoom,
  label,
  onSelect,
  min = 1,
  max = 1,
  dialEnabled = false,
  onDial,
}: {
  stops: Lens[];
  zoom: number;
  label: string;
  onSelect: (z: number) => void;
  min?: number;
  max?: number;
  /** Long-press opens the zoom dial (telephoto phones) */
  dialEnabled?: boolean;
  onDial?: (z: number) => void;
}) {
  const [dial, setDial] = useState(false);
  const g = useRef({ timer: null as ReturnType<typeof setTimeout> | null, closeTimer: null as ReturnType<typeof setTimeout> | null, x0: 0, y0: 0, z0: 1, active: false, lastDial: 0 });
  const liveZoom = useRef(zoom);
  liveZoom.current = zoom;
  const lim = useRef({ min, max, onDial });
  lim.current = { min, max, onDial };

  useEffect(() => () => {
    if (g.current.timer) clearTimeout(g.current.timer);
    if (g.current.closeTimer) clearTimeout(g.current.closeTimer);
  }, []);

  if (stops.length === 0) return null;
  // The pill on the nearest stop at or below the current zoom shows the live value, like Pixel
  let activeIdx = 0;
  stops.forEach((s, i) => {
    if (zoom >= s.zoom * 0.98) activeIdx = i;
  });

  const openDial = (x: number) => {
    g.current.active = true;
    g.current.x0 = x;
    g.current.z0 = liveZoom.current;
    if (g.current.closeTimer) clearTimeout(g.current.closeTimer);
    setDial(true);
  };

  return (
    <View
      onTouchStart={(e) => {
        const { pageX, pageY } = e.nativeEvent;
        g.current.x0 = pageX;
        g.current.y0 = pageY;
        if (!dialEnabled) return;
        if (dial) {
          // dial already showing: drag straight away
          openDial(pageX);
          return;
        }
        if (g.current.timer) clearTimeout(g.current.timer);
        g.current.timer = setTimeout(() => {
          g.current.timer = null;
          Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
          openDial(g.current.x0);
        }, 380);
      }}
      onTouchMove={(e) => {
        const { pageX, pageY } = e.nativeEvent;
        if (g.current.active) {
          const L = lim.current;
          const z = Math.min(L.max, Math.max(L.min, g.current.z0 * Math.exp(-(pageX - g.current.x0) / PX_PER_LOG)));
          L.onDial?.(z);
          return;
        }
        if (g.current.timer && Math.hypot(pageX - g.current.x0, pageY - g.current.y0) > 8) {
          clearTimeout(g.current.timer);
          g.current.timer = null;
        }
      }}
      onTouchEnd={() => {
        if (g.current.timer) { clearTimeout(g.current.timer); g.current.timer = null; }
        if (g.current.active) {
          g.current.active = false;
          g.current.lastDial = Date.now();
          if (g.current.closeTimer) clearTimeout(g.current.closeTimer);
          g.current.closeTimer = setTimeout(() => setDial(false), 1600);
        }
      }}
      onTouchCancel={() => {
        if (g.current.timer) { clearTimeout(g.current.timer); g.current.timer = null; }
        g.current.active = false;
      }}
    >
      <View style={{ opacity: dial ? 0.35 : 1 }}>
        <Glass radius={24} style={styles.zoomBar}>
          <GlassSegmented
            items={stops.map((s) => ({ key: s.label, label: s.label }))}
            value={stops[activeIdx].label}
            activeLabel={`${label}×`}
            onChange={(k) => {
              // ignore the pills while / right after the dial was used
              if (dial || g.current.active || Date.now() - g.current.lastDial < 400) return;
              const st = stops.find((s) => s.label === k);
              if (st) onSelect(st.zoom);
            }}
            height={38}
            fontSize={13}
            paddingH={8}
            minItemWidth={38}
          />
        </Glass>
      </View>
      {dial && <ZoomDial zoom={zoom} min={min} max={max} stops={stops} />}
    </View>
  );
}

/** iOS-style semicircular zoom dial: log-scale ticks turn around the arc under a fixed marker. */
const DIAL_R = 150; // arc radius (px)
const DIAL_K = PX_PER_LOG / DIAL_R; // radians per e-fold of zoom (finger travel = arc travel)

function ZoomDial({ zoom, min, max, stops }: { zoom: number; min: number; max: number; stops: Lens[] }) {
  const R = DIAL_R;
  const H = 128; // visible height of the half-disc
  const cx = R;
  const cy = R + 18; // circle centre (below the visible area's top)
  const ticks: { v: number; major: boolean }[] = [];
  const push = (v: number, major: boolean) => {
    if (v >= min - 1e-6 && v <= max + 1e-6) ticks.push({ v, major });
  };
  for (let v = 0.5; v < 1; v += 0.1) push(Math.round(v * 10) / 10, false);
  for (let v = 1; v < 10; v += 0.5) push(v, Number.isInteger(v));
  for (let v = 10; v < 100; v += 5) push(v, v % 10 === 0);
  push(100, true);
  const labels = Array.from(new Set([...stops.map((s) => s.zoom), 10, 25, 50, 100, max])).filter((v) => v >= min && v <= max);
  const lz = Math.log(zoom);
  const ang = (v: number) => (Math.log(v) - lz) * DIAL_K; // 0 = top centre, + = clockwise
  const LIMIT = 1.45; // ~83°: keep marks on the visible half

  const radial = (a: number, r: number, w: number, h: number) => ({
    position: 'absolute' as const,
    left: cx - w / 2,
    top: cy - h / 2,
    width: w,
    height: h,
    transform: [{ rotate: `${a}rad` }, { translateY: -r }],
  });

  return (
    <View pointerEvents="none" style={{ position: 'absolute', bottom: -6, alignSelf: 'center', width: 2 * R, height: H, overflow: 'hidden' }}>
      <Glass radius={R} style={{ position: 'absolute', left: 0, top: 18, width: 2 * R, height: 2 * R }} />
      {ticks.map((t) => {
        const a = ang(t.v);
        if (Math.abs(a) > LIMIT) return null;
        const fade = 1 - Math.abs(a) / LIMIT;
        const h = t.major ? 14 : 8;
        return (
          <View
            key={`t${t.v}`}
            style={[radial(a, R - 12 - h / 2, 1.5, h), { backgroundColor: `rgba(255,255,255,${0.25 + fade * 0.7})` }]}
          />
        );
      })}
      {labels.map((v) => {
        const a = ang(v);
        if (Math.abs(a) > LIMIT - 0.08) return null;
        return (
          <View key={`l${v}`} style={[radial(a, R - 38, 40, 16), { alignItems: 'center' }]}>
            <Text style={styles.dialLabel}>{v < 1 ? v.toFixed(1) : Math.round(v)}</Text>
          </View>
        );
      })}
      {/* fixed marker at the top */}
      <View style={[radial(0, R - 16, 2.5, 26), { backgroundColor: '#ffd76a', borderRadius: 1.5 }]} />
      <Text style={[styles.dialValue, { position: 'absolute', left: 0, right: 0, top: cy - R + 52 }]}>
        {zoom >= 10 ? Math.round(zoom) : zoom.toFixed(1)}×
      </Text>
    </View>
  );
}

/* ---------------- Mode carousel ---------------- */

export function ModeCarousel({
  mode,
  modes,
  onChange,
  disabled,
}: {
  mode: CaptureMode;
  modes: { key: CaptureMode; label: string }[];
  onChange: (m: CaptureMode) => void;
  disabled?: boolean;
}) {
  return (
    <Glass radius={24} style={styles.modeBar}>
      <GlassSegmented
        items={modes}
        value={mode}
        onChange={(k) => onChange(k as CaptureMode)}
        scrollable
        disabled={disabled}
        height={36}
        fontSize={14}
        paddingH={13}
      />
    </Glass>
  );
}

/* ---------------- Shutter ---------------- */

export function Shutter({
  kind,
  recording,
  busy,
  onPress,
}: {
  kind: ShutterKind;
  recording: boolean;
  busy: boolean;
  onPress: () => void;
}) {
  const scale = useRef(new Animated.Value(1)).current;
  const isVideo = kind === 'video';
  const press = (to: number) =>
    Animated.spring(scale, { toValue: to, useNativeDriver: true, speed: 40, bounciness: 8 }).start();

  return (
    <Pressable
      onPressIn={() => press(0.9)}
      onPressOut={() => press(1)}
      onPress={onPress}
      disabled={busy && !recording}
    >
      <Animated.View style={[styles.shutterOuter, { transform: [{ scale }] }]}>
        <Glass radius={42} style={StyleSheet.absoluteFill} tint="rgba(255,255,255,0.04)" />
        {isVideo ? (
          <View style={[styles.recDot, recording && styles.recSquare]} />
        ) : (
          <View style={[styles.shutterInner, kind === 'night' && styles.shutterNight]}>
            {kind === 'night' && <MaterialCommunityIcons name="weather-night" size={26} color="#1b1b1f" />}
          </View>
        )}
      </Animated.View>
    </Pressable>
  );
}

/* ---------------- Thumbnail ---------------- */

export function Thumb({
  uri,
  processing,
  onPress,
  isVideo,
  enabled,
}: {
  uri?: string;
  processing: boolean;
  onPress: () => void;
  isVideo?: boolean;
  enabled?: boolean;
}) {
  return (
    <Pressable onPress={onPress} disabled={!uri && !enabled}>
      <Glass radius={28} style={styles.thumb}>
        {uri ? (
          <Image source={{ uri }} style={styles.thumbImg} />
        ) : isVideo ? (
          <View style={[StyleSheet.absoluteFill, styles.center]}>
            <MaterialCommunityIcons name="play-circle-outline" size={28} color="#fff" />
          </View>
        ) : null}
        {processing && (
          <View style={[StyleSheet.absoluteFill, styles.center, { backgroundColor: 'rgba(0,0,0,0.14)' }]}>
            <ActivityIndicator color="#fff" />
          </View>
        )}
      </Glass>
    </Pressable>
  );
}

/* ---------------- Icon button ---------------- */

export function IconButton({
  icon,
  onPress,
  active,
  size = 44,
}: {
  icon: React.ComponentProps<typeof MaterialCommunityIcons>['name'];
  onPress: () => void;
  active?: boolean;
  size?: number;
}) {
  return (
    <Pressable onPress={onPress} hitSlop={8}>
      <GlassCircle size={size} active={active}>
        <MaterialCommunityIcons name={icon} size={size * 0.48} color={active ? '#111' : '#fff'} />
      </GlassCircle>
    </Pressable>
  );
}

/* ---------------- Pixel-style Brightness / Shadows sliders ---------------- */

export function ToneSliders({
  brightness,
  shadows,
  onBrightness,
  onShadows,
  showShadows,
}: {
  brightness: number;
  shadows: number;
  onBrightness: (v: number) => void;
  onShadows: (v: number) => void;
  showShadows: boolean;
}) {
  const [tab, setTab] = useState<'brightness' | 'shadows'>('brightness');
  const value = tab === 'brightness' ? brightness : shadows;
  const set = tab === 'brightness' ? onBrightness : onShadows;
  return (
    <Glass radius={24} style={styles.sliderCard}>
      <GlassSegmented
        items={[
          { key: 'brightness', label: '', icon: 'brightness-6' },
          ...(showShadows ? [{ key: 'shadows', label: '', icon: 'circle-half-full' as const }] : []),
        ]}
        value={tab}
        onChange={(k) => setTab(k as 'brightness' | 'shadows')}
        height={34}
        fontSize={18}
        paddingH={6}
        minItemWidth={34}
      />
      <Slider value={value} onChange={set} />
    </Glass>
  );
}

export function Slider({
  value,
  onChange,
  min = -1,
  max = 1,
}: {
  value: number;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
}) {
  const [width, setWidth] = useState(1);
  const startVal = useRef(value);
  const latest = useRef(value);
  latest.current = value;
  const widthRef = useRef(width);
  widthRef.current = width;
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const rangeRef = useRef({ min, max });
  rangeRef.current = { min, max };

  const pan = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderGrant: () => {
        startVal.current = latest.current;
      },
      onPanResponderMove: (_, g) => {
        const r = rangeRef.current;
        const v = startVal.current + (g.dx / widthRef.current) * (r.max - r.min);
        onChangeRef.current(Math.max(r.min, Math.min(r.max, v)));
      },
    }),
  ).current;

  const x = ((value - min) / (max - min)) * width;
  return (
    <View style={styles.sliderTrackWrap} onLayout={(e) => setWidth(e.nativeEvent.layout.width)} {...pan.panHandlers}>
      <View style={styles.sliderTrack} />
      {min < 0 && max > 0 ? <View style={[styles.sliderCenterTick]} /> : null}
      <View style={[styles.sliderKnob, { left: x - 11 }]} />
    </View>
  );
}

/* ---------------- Focus ring ---------------- */

export function FocusRing({ x, y }: { x: number; y: number }) {
  const anim = useRef(new Animated.Value(1.6)).current;
  const opacity = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    anim.setValue(1.6);
    opacity.setValue(1);
    Animated.sequence([
      Animated.spring(anim, { toValue: 1, useNativeDriver: true, speed: 18 }),
      Animated.delay(1400),
      Animated.timing(opacity, { toValue: 0, duration: 400, useNativeDriver: true }),
    ]).start();
  }, [x, y, anim, opacity]);
  return (
    <Animated.View
      pointerEvents="none"
      style={[styles.focusRing, { left: x - 36, top: y - 36, opacity, transform: [{ scale: anim }] }]}
    />
  );
}

/* ---------------- Toast ---------------- */

export function Toast({ text }: { text: string | null }) {
  if (!text) return null;
  return (
    <Glass radius={18} style={styles.toast}>
      <Text style={styles.toastText}>{text}</Text>
    </Glass>
  );
}

export const styles = StyleSheet.create({
  center: { alignItems: 'center', justifyContent: 'center' },
  zoomBar: { alignSelf: 'center' },
  dialValue: { color: '#ffd76a', fontSize: 14, fontWeight: '700', textAlign: 'center', marginTop: 4, fontVariant: ['tabular-nums'] },
  dialLabel: { width: 40, textAlign: 'center', color: 'rgba(255,255,255,0.9)', fontSize: 11, fontWeight: '700' },
  zoomPill: { minWidth: 38, height: 38, borderRadius: 19, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 6 },
  zoomPillActive: { backgroundColor: 'rgba(255,255,255,0.92)' },
  zoomText: { color: '#fff', fontSize: 13, fontWeight: '600' },
  zoomTextActive: { color: '#111', fontWeight: '700' },
  modeBar: { alignSelf: 'center', maxWidth: '94%' },
  modeChip: { paddingHorizontal: 14, height: 36, borderRadius: 18, justifyContent: 'center' },
  modeChipActive: { backgroundColor: 'rgba(214,228,255,0.95)' },
  modeText: { color: 'rgba(255,255,255,0.85)', fontSize: 14, fontWeight: '600' },
  modeTextActive: { color: '#0b1f44' },
  shutterOuter: { width: 84, height: 84, borderRadius: 42, alignItems: 'center', justifyContent: 'center' },
  shutterInner: { width: 66, height: 66, borderRadius: 33, backgroundColor: '#fff', alignItems: 'center', justifyContent: 'center' },
  shutterNight: { backgroundColor: '#e9e6ff' },
  recDot: { width: 62, height: 62, borderRadius: 31, backgroundColor: '#ff3b30' },
  recSquare: { width: 30, height: 30, borderRadius: 8 },
  thumb: { width: 56, height: 56 },
  thumbImg: { width: '100%', height: '100%' },
  sliderCard: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 14, height: 52, gap: 12, alignSelf: 'center', width: 300 },
  sliderTabs: { flexDirection: 'row', gap: 12 },
  sliderTrackWrap: { flex: 1, height: 44, justifyContent: 'center' },
  sliderTrack: { height: 4, borderRadius: 2, backgroundColor: 'rgba(255,255,255,0.18)' },
  sliderCenterTick: { position: 'absolute', left: '50%', width: 2, height: 12, marginLeft: -1, backgroundColor: 'rgba(255,255,255,0.7)' },
  sliderKnob: { position: 'absolute', width: 22, height: 22, borderRadius: 11, backgroundColor: '#ffd76a', borderWidth: 2, borderColor: '#fff' },
  focusRing: { position: 'absolute', width: 72, height: 72, borderRadius: 36, borderWidth: 2, borderColor: 'rgba(255,255,255,0.95)' },
  toast: { alignSelf: 'center', paddingHorizontal: 16, paddingVertical: 9 },
  toastText: { color: '#fff', fontSize: 13, fontWeight: '600' },
});
