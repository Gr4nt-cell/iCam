import { BlurView } from 'expo-blur';
import { LinearGradient } from 'expo-linear-gradient';
import React from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

type Props = {
  style?: StyleProp<ViewStyle>;
  radius?: number;
  intensity?: number;
  /** Extra tint behind the content; keeps text legible even where blur can't sample the preview. */
  tint?: string;
  children?: React.ReactNode;
};

/**
 * Liquid Glass surface: frosted blur + specular top highlight + inner rim light.
 */
export function Glass({ style, radius = 26, intensity = 18, tint = 'rgba(67,46,36,0.22)', children }: Props) {
  return (
    <View style={[{ borderRadius: radius, overflow: 'hidden' }, style]}>
      <BlurView
        intensity={intensity}
        tint="dark"
        experimentalBlurMethod="dimezisBlurView"
        style={StyleSheet.absoluteFill}
      />
      <View style={[StyleSheet.absoluteFill, { backgroundColor: tint }]} />
      <LinearGradient
        pointerEvents="none"
        colors={['rgba(255,247,231,0.17)', 'rgba(255,228,198,0.035)', 'rgba(255,221,181,0.018)', 'rgba(255,194,136,0.07)']}
        locations={[0, 0.35, 0.7, 1]}
        style={StyleSheet.absoluteFill}
      />
      <View
        pointerEvents="none"
        style={[
          StyleSheet.absoluteFill,
          {
            borderRadius: radius,
            borderWidth: 1,
            borderTopColor: 'rgba(255,247,231,0.32)',
            borderLeftColor: 'rgba(255,238,213,0.18)',
            borderRightColor: 'rgba(255,223,190,0.13)',
            borderBottomColor: 'rgba(255,220,186,0.09)',
          },
        ]}
      />
      {children}
    </View>
  );
}

/** Small round glass button. */
export function GlassCircle({ size = 44, children, active }: { size?: number; children?: React.ReactNode; active?: boolean }) {
  return (
    <Glass
      radius={size / 2}
      style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }}
      tint={active ? 'rgba(255,185,111,0.32)' : 'rgba(67,46,36,0.22)'}
    >
      {children}
    </Glass>
  );
}
