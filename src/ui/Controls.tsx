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
import type { CaptureMode, Lens } from '../camera/hardware';
import { Glass, GlassCircle } from './Glass';
import { GlassSegmented } from './GlassSegmented';

export const MODES: { key: CaptureMode; label: string }[] = [
  { key: 'night', label: 'Night Sight' },
  { key: 'pro', label: 'Pro' },
  { key: 'photo', label: 'Photo' },
  { key: 'video', label: 'Video' },
  { key: 'slowmo', label: 'Slo-mo' },
  { key: 'dual', label: 'Dual' },
  { key: 'action', label: 'Action' },
];

export type ShutterKind = 'photo' | 'night' | 'video';

/* ---------------- Zoom pills ---------------- */

export function ZoomPills({
  stops,
  zoom,
  label,
  onSelect,
}: {
  stops: Lens[];
  zoom: number;
  label: string;
  onSelect: (z: number) => void;
}) {
  if (stops.length === 0) return null;
  // The pill on the nearest stop at or below the current zoom shows the live value, like Pixel
  let activeIdx = 0;
  stops.forEach((s, i) => {
    if (zoom >= s.zoom * 0.98) activeIdx = i;
  });
  return (
    <Glass radius={24} style={styles.zoomBar}>
      <GlassSegmented
        items={stops.map((s) => ({ key: s.label, label: s.label }))}
        value={stops[activeIdx].label}
        activeLabel={`${label}×`}
        onChange={(k) => {
          const st = stops.find((s) => s.label === k);
          if (st) onSelect(st.zoom);
        }}
        height={38}
        fontSize={13}
        paddingH={8}
        minItemWidth={38}
      />
    </Glass>
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

export function Thumb({ uri, processing, onPress }: { uri?: string; processing: boolean; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} disabled={!uri}>
      <Glass radius={28} style={styles.thumb}>
        {uri ? <Image source={{ uri }} style={styles.thumbImg} /> : null}
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
