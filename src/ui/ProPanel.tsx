import { MaterialCommunityIcons } from '@expo/vector-icons';
import React, { useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import type { Capabilities, WhiteBalance } from '../../modules/icamera';
import { FILTERS, type FilterKey } from '../processing/filters';
import { Slider } from './Controls';
import { Glass } from './Glass';

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
          <MaterialCommunityIcons name={video ? 'video' : 'camera'} size={16} color="#0b1f44" />
          <Text style={s.capToggleText}>{video ? 'Video' : 'Photo'}</Text>
        </Pressable>
      </View>

      <View style={s.tabs}>
        {tabs.map(([k, label]) => (
          <Pressable key={k} onPress={() => setTab(k)} style={[s.tab, tab === k && s.tabActive]}>
            <Text style={[s.tabText, tab === k && s.tabTextActive]}>{label}</Text>
          </Pressable>
        ))}
      </View>

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
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={s.chips}>
          {tab === 'iso' && (
            <>
              <Chip label="Auto" active={!value.iso} onPress={() => setIso(0)} />
              {isoStops.map((i) => (
                <Chip key={i} label={String(i)} active={value.iso === i} onPress={() => setIso(i)} />
              ))}
            </>
          )}
          {tab === 'shutter' && (
            <>
              <Chip label="Auto" active={!value.shutterNs} onPress={() => setShutter(0)} />
              {shutterStops.map(([l, ns]) => (
                <Chip key={l} label={l} active={Math.abs(value.shutterNs - ns) < 1} onPress={() => setShutter(ns)} />
              ))}
            </>
          )}
          {tab === 'wb' && (
            <>
              {WB_PRESETS.map(([k, l, icon]) => (
                <Chip
                  key={k}
                  label={l}
                  icon={icon}
                  active={value.whiteBalance === k}
                  onPress={() => onChange({ ...value, whiteBalance: k })}
                />
              ))}
              {(caps?.manualWhiteBalance ?? true) &&
                KELVIN_STOPS.map((k) => (
                  <Chip
                    key={k}
                    label={`${k}K`}
                    active={value.whiteBalance === 'kelvin' && value.kelvin === k}
                    onPress={() => onChange({ ...value, whiteBalance: 'kelvin', kelvin: k })}
                  />
                ))}
            </>
          )}
          {tab === 'focus' && (
            <>
              <Chip label="Auto" active={value.focusDistance < 0} onPress={() => onChange({ ...value, focusDistance: -1 })} />
              <Chip label="∞" active={value.focusDistance === 0} onPress={() => onChange({ ...value, focusDistance: 0 })} />
              {focusStops.map(([l, d]) => (
                <Chip
                  key={l}
                  label={l}
                  active={Math.abs(value.focusDistance - d) < 0.001}
                  onPress={() => onChange({ ...value, focusDistance: d })}
                />
              ))}
            </>
          )}
        </ScrollView>
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
}: {
  filter: FilterKey;
  onFilter: (f: FilterKey) => void;
  smoothing: number;
  onSmoothing: (v: number) => void;
}) {
  return (
    <Glass radius={26} style={s.card}>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={s.chips}>
        {FILTERS.map((f) => (
          <Chip key={f.key} label={f.label} active={filter === f.key} onPress={() => onFilter(f.key)} />
        ))}
      </ScrollView>
      <View style={s.evRow}>
        <MaterialCommunityIcons name="face-recognition" size={20} color="#fff" />
        <Text style={s.smoothLabel}>Smooth</Text>
        <View style={{ flex: 1 }}>
          <Slider value={smoothing} min={0} max={1} onChange={onSmoothing} />
        </View>
        <Text style={s.evLabel}>{Math.round(smoothing * 100)}</Text>
      </View>
    </Glass>
  );
}

const s = StyleSheet.create({
  card: { marginHorizontal: 12, paddingVertical: 10, gap: 8 },
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 14, gap: 10 },
  readout: { flex: 1, color: '#fff', fontSize: 12, fontWeight: '700', letterSpacing: 0.3, fontVariant: ['tabular-nums'] },
  capToggle: { flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: 'rgba(214,228,255,0.95)', borderRadius: 14, paddingHorizontal: 10, height: 28 },
  capToggleText: { color: '#0b1f44', fontWeight: '700', fontSize: 12 },
  tabs: { flexDirection: 'row', paddingHorizontal: 10, gap: 4 },
  tab: { flex: 1, height: 30, borderRadius: 15, alignItems: 'center', justifyContent: 'center' },
  tabActive: { backgroundColor: 'rgba(255,255,255,0.16)' },
  tabText: { color: 'rgba(255,255,255,0.7)', fontSize: 13, fontWeight: '600' },
  tabTextActive: { color: '#fff' },
  chips: { paddingHorizontal: 10, gap: 6, alignItems: 'center' },
  chip: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 12, height: 34, borderRadius: 17, backgroundColor: 'rgba(255,255,255,0.10)' },
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
