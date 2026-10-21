import { MaterialCommunityIcons } from '@expo/vector-icons';
import React, { useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import type { Capabilities, WhiteBalance } from '../../modules/icamera';
import { FILTERS, type FilterKey } from '../processing/filters';
import { Slider } from './Controls';
import { Glass } from './Glass';
import { GlassSegmented, type SegItem } from './GlassSegmented';

export type ManualSettings = {
  iso: number; // 0 = auto
  shutterNs: number; // 0 = auto
  whiteBalance: WhiteBalance;
  kelvin: number;
  focusDistance: number; // -1 = auto
  ev: number;
};

export const AUTO_MANUAL: ManualSettings = {
  iso: 0,
  shutterNs: 0,
  whiteBalance: 'auto',
  kelvin: 5600,
  focusDistance: -1,
  ev: 0,
};

const ISO_STOPS = [50, 64, 100, 125, 200, 400, 800, 1600, 3200, 6400, 12800];
const SHUTTER_STOPS: [string, number][] = [
  ['1/8000', 1e9 / 8000],
  ['1/4000', 1e9 / 4000],
  ['1/2000', 1e9 / 2000],
  ['1/1000', 1e9 / 1000],
  ['1/500', 1e9 / 500],
  ['1/250', 1e9 / 250],
  ['1/125', 1e9 / 125],
  ['1/60', 1e9 / 60],
  ['1/30', 1e9 / 30],
  ['1/15', 1e9 / 15],
  ['1/8', 1e9 / 8],
  ['1/4', 1e9 / 4],
  ['1/2', 1e9 / 2],
  ['1"', 1e9],
];
const WB_PRESETS: [WhiteBalance, string, React.ComponentProps<typeof MaterialCommunityIcons>['name']][] = [
  ['auto', 'Auto', 'white-balance-auto'],
  ['daylight', 'Daylight', 'white-balance-sunny'],
  ['cloudy', 'Cloudy', 'weather-cloudy'],
  ['shade', 'Shade', 'weather-partly-cloudy'],
  ['tungsten', 'Tungsten', 'white-balance-incandescent'],
  ['fluorescent', 'Fluorescent', 'white-balance-iridescent'],
  ['twilight', 'Twilight', 'weather-sunset'],
];
const KELVIN_STOPS = [2800, 3200, 4000, 4800, 5600, 6500, 7500, 9000];

type Tab = 'iso' | 'shutter' | 'wb' | 'focus' | 'ev';

export function shutterLabel(ns: number) {
  if (!ns) return 'Auto';
  const s = ns / 1e9;
  return s >= 1 ? `${s.toFixed(0)}"` : `1/${Math.round(1 / s)}`;
}

export function ProPanel({
  value,
  onChange,
  caps,
  video,
  onToggleVideo,
}: {
  value: ManualSettings;
  onChange: (v: ManualSettings) => void;
  caps: Capabilities | null;
  video: boolean;
  onToggleVideo: () => void;
}) {
  const [tab, setTab] = useState<Tab>('iso');
  const manual = caps?.manualSensor ?? false;

  const isoStops = useMemo(() => {
    if (!caps || !caps.isoMax) return ISO_STOPS;
    return ISO_STOPS.filter((i) => i >= caps.isoMin && i <= caps.isoMax);
  }, [caps]);
  const shutterStops = useMemo(() => {
    if (!caps || !caps.exposureMaxNs) return SHUTTER_STOPS;
    // Video can't expose longer than a frame
    const maxNs = video ? Math.min(caps.exposureMaxNs, 1e9 / 30) : caps.exposureMaxNs;
    return SHUTTER_STOPS.filter(([, ns]) => ns >= caps.exposureMinNs && ns <= maxNs);
  }, [caps, video]);
  const focusStops = useMemo(() => {
    const mf = caps?.minFocusDistance ?? 0;
    if (!mf) return [] as [string, number][];
    return [0.1, 0.25, 0.5, 0.75, 1].map((f) => {
      const d = mf * f;
      const m = 1 / d;
      return [m >= 1 ? `${m.toFixed(1)} m` : `${Math.round(m * 100)} cm`, d] as [string, number];
    });
  }, [caps]);

  // Manual exposure needs both ISO and shutter; fill in the other with a sensible value
  const setIso = (iso: number) =>
    onChange({ ...value, iso, shutterNs: iso && !value.shutterNs ? 1e9 / 60 : iso ? value.shutterNs : 0 });
  const setShutter = (shutterNs: number) =>
    onChange({ ...value, shutterNs, iso: shutterNs && !value.iso ? 200 : shutterNs ? value.iso : 0 });

  const options = useMemo((): { items: SegItem[]; value: string; select: (k: string) => void } => {
    if (tab === 'iso') {
      return {
        items: [{ key: '0', label: 'Auto' }, ...isoStops.map((i) => ({ key: String(i), label: String(i) }))],
        value: String(value.iso),
        select: (k) => setIso(Number(k)),
      };
    }
    if (tab === 'shutter') {
      const cur = shutterStops.find(([, ns]) => Math.abs(value.shutterNs - ns) < 1);
      return {
        items: [{ key: 'auto', label: 'Auto' }, ...shutterStops.map(([l]) => ({ key: l, label: l }))],
        value: value.shutterNs ? cur?.[0] ?? 'auto' : 'auto',
        select: (k) => setShutter(k === 'auto' ? 0 : shutterStops.find(([l]) => l === k)?.[1] ?? 0),
      };
    }
    if (tab === 'wb') {
      const kelvinItems = (caps?.manualWhiteBalance ?? true)
        ? KELVIN_STOPS.map((k) => ({ key: `k${k}`, label: `${k}K` }))
        : [];
      return {
        items: [...WB_PRESETS.map(([k, l, icon]) => ({ key: k, label: l, icon })), ...kelvinItems],
        value: value.whiteBalance === 'kelvin' ? `k${value.kelvin}` : value.whiteBalance,
        select: (k) =>
          k.startsWith('k') && /^k\d+$/.test(k)
            ? onChange({ ...value, whiteBalance: 'kelvin', kelvin: Number(k.slice(1)) })
            : onChange({ ...value, whiteBalance: k as WhiteBalance }),
      };
    }
    // focus
    const cur = focusStops.find(([, d]) => Math.abs(value.focusDistance - d) < 0.001);
    return {
      items: [{ key: 'auto', label: 'Auto' }, { key: 'inf', label: '∞' }, ...focusStops.map(([l]) => ({ key: l, label: l }))],
      value: value.focusDistance < 0 ? 'auto' : value.focusDistance === 0 ? 'inf' : cur?.[0] ?? 'auto',
      select: (k) =>
        onChange({
          ...value,
          focusDistance: k === 'auto' ? -1 : k === 'inf' ? 0 : focusStops.find(([l]) => l === k)?.[1] ?? -1,
        }),
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, value, isoStops, shutterStops, focusStops, caps]);

  const readout = [
    value.iso ? `ISO ${value.iso}` : 'ISO A',
    value.shutterNs ? shutterLabel(value.shutterNs) : 'S A',
    value.whiteBalance === 'kelvin' ? `${value.kelvin}K` : `WB ${value.whiteBalance === 'auto' ? 'A' : value.whiteBalance}`,
    value.focusDistance < 0 ? 'AF' : value.focusDistance === 0 ? 'MF ∞' : 'MF',
    !value.iso && value.ev ? `${value.ev > 0 ? '+' : ''}${value.ev.toFixed(1)} EV` : null,
  ]
    .filter(Boolean)
    .join('  ·  ');

  const tabs: [Tab, string][] = [
    ['iso', 'ISO'],
    ['shutter', 'Shutter'],
    ['wb', 'WB'],
    ['focus', 'Focus'],
    ['ev', 'EV'],
  ];

  return (
    <Glass radius={26} style={s.card}>
      <View style={s.header}>
        <Text style={s.readout} numberOfLines={1}>
          {readout}
        </Text>
        <Pressable onPress={onToggleVideo} style={s.capToggle} hitSlop={6}>
          <MaterialCommunityIcons name={video ? 'video' : 'camera'} size={16} color="#fff" />
          <Text style={s.capToggleText}>{video ? 'Video' : 'Photo'}</Text>
        </Pressable>
      </View>

      <GlassSegmented
        items={tabs.map(([k, label]) => ({ key: k, label }))}
        value={tab}
        onChange={(k) => setTab(k as Tab)}
        height={30}
        fontSize={13}
        paddingH={12}
        style={{ alignSelf: 'center' }}
      />

      {!manual && (tab === 'iso' || tab === 'shutter' || tab === 'focus') ? (
        <Text style={s.note}>This camera doesn't allow manual sensor control — EV and white balance still work.</Text>
      ) : tab === 'ev' ? (
        <View style={s.evRow}>
          <Text style={s.evLabel}>-2</Text>
          <View style={{ flex: 1 }}>
            <Slider value={value.ev} min={-2} max={2} onChange={(ev) => onChange({ ...value, ev: Math.round(ev * 3) / 3 })} />
          </View>
          <Text style={s.evLabel}>+2</Text>
        </View>
      ) : (
        <GlassSegmented
          scrollable
          height={32}
          fontSize={13}
          paddingH={12}
          items={options.items}
          value={options.value}
          onChange={options.select}
        />
      )}
      <Pressable onPress={() => onChange(AUTO_MANUAL)} style={s.reset} hitSlop={6}>
        <Text style={s.resetText}>Reset all to auto</Text>
      </Pressable>
    </Glass>
  );
}

function Chip({
  label,
  active,
  onPress,
  icon,
}: {
  label: string;
  active: boolean;
  onPress: () => void;
  icon?: React.ComponentProps<typeof MaterialCommunityIcons>['name'];
}) {
  return (
    <Pressable onPress={onPress} style={[s.chip, active && s.chipActive]}>
      {icon ? <MaterialCommunityIcons name={icon} size={15} color={active ? '#0b1f44' : '#fff'} /> : null}
      <Text style={[s.chipText, active && s.chipTextActive]}>{label}</Text>
    </Pressable>
  );
}

/* ---------------- Filters + face smoothing ---------------- */

export function LookPanel({
  filter,
  onFilter,
  smoothing,
  onSmoothing,
  blur,
  onBlur,
}: {
  filter: FilterKey;
  onFilter: (f: FilterKey) => void;
  smoothing: number;
  onSmoothing: (v: number) => void;
  /** Portrait background blur strength (shown only in Portrait mode) */
  blur?: number;
  onBlur?: (v: number) => void;
}) {
  return (
    <Glass radius={26} style={s.card}>
      <GlassSegmented
        scrollable
        height={32}
        fontSize={13}
        paddingH={12}
        items={FILTERS.map((f) => ({ key: f.key, label: f.label }))}
        value={filter}
        onChange={(k) => onFilter(k as FilterKey)}
      />
      <View style={s.evRow}>
        <MaterialCommunityIcons name="face-recognition" size={20} color="#fff" />
        <Text style={s.smoothLabel}>Smooth</Text>
        <View style={{ flex: 1 }}>
          <Slider value={smoothing} min={0} max={1} onChange={onSmoothing} />
        </View>
        <Text style={s.evLabel}>{Math.round(smoothing * 100)}</Text>
      </View>
      {blur !== undefined && onBlur ? (
        <View style={s.evRow}>
          <MaterialCommunityIcons name="blur" size={20} color="#fff" />
          <Text style={s.smoothLabel}>Blur</Text>
          <View style={{ flex: 1 }}>
            <Slider value={blur} min={0} max={1} onChange={onBlur} />
          </View>
          <Text style={s.evLabel}>{Math.round(blur * 100)}</Text>
        </View>
      ) : null}
    </Glass>
  );
}

const s = StyleSheet.create({
  card: { marginHorizontal: 12, paddingVertical: 10, gap: 8 },
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 14, gap: 10 },
  readout: { flex: 1, color: '#fff', fontSize: 12, fontWeight: '700', letterSpacing: 0.3, fontVariant: ['tabular-nums'] },
  capToggle: { flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: 'rgba(255,255,255,0.16)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.4)', borderRadius: 14, paddingHorizontal: 10, height: 28 },
  capToggleText: { color: '#fff', fontWeight: '700', fontSize: 12 },
  tabs: { flexDirection: 'row', paddingHorizontal: 10, gap: 4 },
  tab: { flex: 1, height: 30, borderRadius: 15, alignItems: 'center', justifyContent: 'center' },
  tabActive: { backgroundColor: 'rgba(255,255,255,0.064)' },
  tabText: { color: 'rgba(255,255,255,0.7)', fontSize: 13, fontWeight: '600' },
  tabTextActive: { color: '#fff' },
  chips: { paddingHorizontal: 10, gap: 6, alignItems: 'center' },
  chip: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 12, height: 34, borderRadius: 17, backgroundColor: 'rgba(255,255,255,0.04)' },
  chipActive: { backgroundColor: 'rgba(214,228,255,0.95)' },
  chipText: { color: '#fff', fontSize: 13, fontWeight: '600' },
  chipTextActive: { color: '#0b1f44' },
  evRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 14 },
  evLabel: { color: 'rgba(255,255,255,0.8)', fontSize: 12, fontWeight: '600', minWidth: 22, textAlign: 'center' },
  smoothLabel: { color: '#fff', fontSize: 13, fontWeight: '600' },
  note: { color: 'rgba(255,255,255,0.7)', fontSize: 12, paddingHorizontal: 14, paddingVertical: 8 },
  reset: { alignSelf: 'center' },
  resetText: { color: '#8ab4f8', fontSize: 12, fontWeight: '600' },
});
