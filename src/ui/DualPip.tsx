import { MaterialCommunityIcons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import React, { useMemo, useRef, useState } from 'react';
import { Animated, PanResponder, StyleSheet, Text, useWindowDimensions, View } from 'react-native';

type Pip = { x: number; y: number; size: number };

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/**
 * Glass frame over the dual-camera inset. Drag it anywhere; tap it to swap the cameras.
 * The camera re-composes the picture-in-picture to the new spot when you let go
 * (position is locked while recording).
 */
export function DualPipFrame({
  pip,
  locked,
  onMove,
  onSwap,
}: {
  pip: Pip;
  locked: boolean;
  onMove: (x: number, y: number) => void;
  onSwap: () => void;
}) {
  const { width: W, height: H } = useWindowDimensions();
  const fw = pip.size * W;
  const fh = fw * (4 / 3); // matches the 3:4 inset the camera draws
  const cx = clamp(pip.x * W, fw / 2, W - fw / 2);
  const cy = clamp(pip.y * H, fh / 2, H - fh / 2);

  const drag = useRef(new Animated.ValueXY()).current;
  const [dragging, setDragging] = useState(false);
  const live = useRef({ cx, cy, fw, fh, W, H, locked, onMove, onSwap });
  live.current = { cx, cy, fw, fh, W, H, locked, onMove, onSwap };

  const pan = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: () => true,
        onPanResponderTerminationRequest: () => false,
        onPanResponderGrant: () => {
          setDragging(true);
          Haptics.selectionAsync();
        },
        onPanResponderMove: (_, g) => {
          if (live.current.locked) return;
          drag.setValue({ x: g.dx, y: g.dy });
        },
        onPanResponderRelease: (_, g) => {
          const L = live.current;
          setDragging(false);
          drag.setValue({ x: 0, y: 0 });
          if (Math.abs(g.dx) < 6 && Math.abs(g.dy) < 6) {
            L.onSwap();
            return;
          }
          if (L.locked) return;
          const nx = clamp(L.cx + g.dx, L.fw / 2, L.W - L.fw / 2) / L.W;
          const ny = clamp(L.cy + g.dy, L.fh / 2, L.H - L.fh / 2) / L.H;
          Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
          L.onMove(nx, ny);
        },
        onPanResponderTerminate: () => {
          setDragging(false);
          drag.setValue({ x: 0, y: 0 });
        },
      }),
    [drag],
  );

  return (
    <Animated.View
      {...pan.panHandlers}
      style={[
        styles.frame,
        {
          width: fw,
          height: fh,
          left: cx - fw / 2,
          top: cy - fh / 2,
          transform: drag.getTranslateTransform(),
          backgroundColor: dragging ? 'rgba(255,255,255,0.10)' : 'transparent',
        },
      ]}
    >
      <View style={styles.badge}>
        <MaterialCommunityIcons name={locked ? 'lock-outline' : 'swap-horizontal'} size={14} color="#fff" />
        {dragging && !locked ? <Text style={styles.badgeText}>Move</Text> : null}
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  frame: {
    position: 'absolute',
    borderRadius: 18,
    borderWidth: 1.5,
    borderTopColor: 'rgba(255,255,255,0.75)',
    borderLeftColor: 'rgba(255,255,255,0.5)',
    borderRightColor: 'rgba(255,255,255,0.4)',
    borderBottomColor: 'rgba(255,255,255,0.3)',
  },
  badge: {
    position: 'absolute',
    right: 6,
    top: 6,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    paddingHorizontal: 6,
    height: 22,
    borderRadius: 11,
    backgroundColor: 'rgba(255,255,255,0.18)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.4)',
  },
  badgeText: { color: '#fff', fontSize: 11, fontWeight: '700' },
});
