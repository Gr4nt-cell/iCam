import { MaterialCommunityIcons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { LinearGradient } from 'expo-linear-gradient';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import Animated, { useAnimatedStyle, useSharedValue, withSpring, withTiming } from 'react-native-reanimated';
import {
  PanResponder,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native';

export type SegItem = {
  key: string;
  label: string;
  icon?: React.ComponentProps<typeof MaterialCommunityIcons>['name'];
};

type Props = {
  items: SegItem[];
  value: string;
  onChange: (key: string) => void;
  /** Horizontal scrolling for long lists (modes, ISO values, filters…) */
  scrollable?: boolean;
  height?: number;
  fontSize?: number;
  paddingH?: number;
  minItemWidth?: number;
  disabled?: boolean;
  style?: StyleProp<ViewStyle>;
  /** Overrides the label shown on the selected item (e.g. live zoom "1.4×") */
  activeLabel?: string;
};

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
/** Soft glide with a hint of overshoot; runs on the UI thread so camera work never stutters it */
const GLIDE = { damping: 22, stiffness: 240, mass: 0.9 };
const PRESS = { damping: 18, stiffness: 320 };

/**
 * Liquid-glass segmented selector. The selection pill is a rounded, translucent glass lens that
 * slides between options; it can be dragged across them and snaps to the nearest on release.
 */
export function GlassSegmented({
  items,
  value,
  onChange,
  scrollable,
  height = 36,
  fontSize = 14,
  paddingH = 14,
  minItemWidth = 0,
  disabled,
  style,
  activeLabel,
}: Props) {
  const PAD = 4;
  const layouts = useRef<Record<string, { x: number; w: number }>>({});
  const x = useSharedValue(0);
  const w = useSharedValue(0);
  const opacity = useSharedValue(0);
  const scale = useSharedValue(1);
  const pillStyle = useAnimatedStyle(() => ({
    width: w.value,
    opacity: opacity.value,
    transform: [{ translateX: x.value }, { scaleY: scale.value }, { scaleX: scale.value }],
  }));
  const [hover, setHover] = useState<string | null>(null);
  const hoverRef = useRef<string | null>(null);
  const dragging = useRef(false);
  const dragStart = useRef(0);
  const scrollX = useRef(0);
  const viewportPageX = useRef(0);
  const viewportW = useRef(0);
  const viewRef = useRef<View>(null);
  const scrollRef = useRef<ScrollView>(null);

  const live = useRef({ value, items, disabled, onChange });
  live.current = { value, items, disabled, onChange };

  const moveTo = (k: string, animate = true) => {
    const l = layouts.current[k];
    if (!l) return;
    if (animate && opacity.value > 0) {
      x.value = withSpring(l.x, GLIDE);
      w.value = withSpring(l.w, GLIDE);
    } else {
      x.value = l.x;
      w.value = l.w;
      opacity.value = withTiming(1, { duration: 180 });
    }
  };

  const ensureVisible = (k: string) => {
    const l = layouts.current[k];
    if (!scrollable || !l || !viewportW.current) return;
    const target = l.x + l.w / 2 - viewportW.current / 2;
    scrollRef.current?.scrollTo({ x: Math.max(0, target), animated: true });
  };

  useEffect(() => {
    if (dragging.current) return;
    moveTo(value);
    ensureVisible(value);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  const measureViewport = () => {
    viewRef.current?.measure((_x, _y, width, _h, pageX) => {
      viewportPageX.current = pageX ?? 0;
      viewportW.current = width ?? 0;
    });
  };

  const nearest = (centerX: number) => {
    let best: string | null = null;
    let d = Infinity;
    for (const it of live.current.items) {
      const l = layouts.current[it.key];
      if (!l) continue;
      const dd = Math.abs(l.x + l.w / 2 - centerX);
      if (dd < d) {
        d = dd;
        best = it.key;
      }
    }
    return best;
  };

  const pan = useMemo(
    () =>
      PanResponder.create({
        // Claim the gesture only when it starts on the pill; taps elsewhere go to the items
        onStartShouldSetPanResponderCapture: (e) => {
          if (live.current.disabled) return false;
          const l = layouts.current[live.current.value];
          if (!l) return false;
          const cx = e.nativeEvent.pageX - viewportPageX.current + scrollX.current;
          return cx >= l.x - 6 && cx <= l.x + l.w + 6;
        },
        onMoveShouldSetPanResponderCapture: () => false,
        onPanResponderTerminationRequest: () => false,
        onPanResponderGrant: () => {
          const l = layouts.current[live.current.value];
          dragging.current = true;
          dragStart.current = l?.x ?? 0;
          hoverRef.current = live.current.value;
          scale.value = withSpring(1.08, PRESS);
        },
        onPanResponderMove: (_, g) => {
          const keys = live.current.items.map((i) => i.key).filter((k) => layouts.current[k]);
          if (!keys.length) return;
          const first = layouts.current[keys[0]];
          const last = layouts.current[keys[keys.length - 1]];
          const cur = layouts.current[live.current.value];
          const pillW = cur?.w ?? first.w;
          const nx = clamp(dragStart.current + g.dx, first.x, last.x + last.w - pillW);
          x.value = nx;
          const k = nearest(nx + pillW / 2);
          if (k && k !== hoverRef.current) {
            hoverRef.current = k;
            setHover(k);
            w.value = withSpring(layouts.current[k].w, GLIDE);
            Haptics.selectionAsync();
          }
        },
        onPanResponderRelease: (_, g) => finishDrag(Math.abs(g.dx) < 4),
        onPanResponderTerminate: () => finishDrag(false),
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const finishDrag = (wasTap: boolean) => {
    dragging.current = false;
    scale.value = withSpring(1, PRESS);
    const k = wasTap ? live.current.value : hoverRef.current ?? live.current.value;
    hoverRef.current = null;
    setHover(null);
    moveTo(k);
    if (k !== live.current.value) live.current.onChange(k);
  };

  const shown = hover ?? value;

  const row = (
    <View style={[s.row, { padding: PAD }]}>
      <Animated.View
        pointerEvents="none"
        style={[
          s.pill,
          {
            top: PAD,
            height,
            borderRadius: height / 2,
          },
          pillStyle,
        ]}
      >
        <LinearGradient
          colors={['rgba(255,255,255,0.30)', 'rgba(255,255,255,0.06)', 'rgba(255,255,255,0.14)']}
          locations={[0, 0.55, 1]}
          style={[StyleSheet.absoluteFill, { borderRadius: height / 2 }]}
        />
        <View
          style={[
            StyleSheet.absoluteFill,
            {
              borderRadius: height / 2,
              borderWidth: 1,
              borderTopColor: 'rgba(255,255,255,0.55)',
              borderLeftColor: 'rgba(255,255,255,0.30)',
              borderRightColor: 'rgba(255,255,255,0.22)',
              borderBottomColor: 'rgba(255,255,255,0.14)',
            },
          ]}
        />
      </Animated.View>
      {items.map((it) => {
        const active = it.key === shown;
        return (
          <Pressable
            key={it.key}
            disabled={disabled}
            hitSlop={4}
            onPress={() => {
              if (it.key !== value) {
                Haptics.selectionAsync();
                onChange(it.key);
              }
            }}
            onLayout={(e) => {
              const { x: lx, width } = e.nativeEvent.layout;
              layouts.current[it.key] = { x: lx, w: width };
              if (it.key === value && !dragging.current) {
                moveTo(value, false);
                ensureVisible(value);
              }
            }}
            style={[s.item, { height, paddingHorizontal: paddingH, minWidth: minItemWidth, borderRadius: height / 2 }]}
          >
            {it.icon ? (
              <MaterialCommunityIcons name={it.icon} size={fontSize + 2} color={active ? '#fff' : 'rgba(255,255,255,0.75)'} />
            ) : null}
            <Text
              numberOfLines={1}
              style={[s.text, { fontSize }, active && s.textActive, disabled && { opacity: 0.5 }]}
            >
              {active && activeLabel && it.key === value ? activeLabel : it.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );

  return (
    <View ref={viewRef} onLayout={measureViewport} style={style} {...pan.panHandlers}>
      {scrollable ? (
        <ScrollView
          ref={scrollRef}
          horizontal
          style={{ flexGrow: 0 }}
          showsHorizontalScrollIndicator={false}
          scrollEventThrottle={16}
          onScroll={(e) => {
            scrollX.current = e.nativeEvent.contentOffset.x;
          }}
          onMomentumScrollEnd={measureViewport}
        >
          {row}
        </ScrollView>
      ) : (
        row
      )}
    </View>
  );
}

const s = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center' },
  pill: {
    position: 'absolute',
    left: 0,
    backgroundColor: 'rgba(255,255,255,0.16)',
    overflow: 'hidden',
  },
  item: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 4 },
  text: { color: 'rgba(255,255,255,0.78)', fontWeight: '600' },
  textActive: {
    color: '#fff',
    fontWeight: '700',
    textShadowColor: 'rgba(0,0,0,0.45)',
    textShadowRadius: 4,
    textShadowOffset: { width: 0, height: 1 },
  },
});
