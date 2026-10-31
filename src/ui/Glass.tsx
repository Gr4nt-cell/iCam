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
export function Glass({ style, radius = 26, intensity = 32, tint = 'rgba(15,24,34,0.56)', children }: Props) {
  return (
    <View style={[{ borderRadius: radius, overflow: 'hidden' }, style]}>
      <BlurView
        intensity={intensity}
        tint="dark"
        pointerEvents="none"
        experimentalBlurMethod="dimezisBlurView"
        style={StyleSheet.absoluteFill}
      />
      <View pointerEvents="none" style={[StyleSheet.absoluteFill, { backgroundColor: tint }]} />
      <LinearGradient
        pointerEvents="none"
        colors={['rgba(221,241,255,0.24)', 'rgba(255,255,255,0.065)', 'rgba(255,255,255,0.018)', 'rgba(162,209,255,0.10)']}
        locations={[0, 0.32, 0.72, 1]}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 1 }}
        style={StyleSheet.absoluteFill}
      />
      <View
        pointerEvents="none"
        style={[
          StyleSheet.absoluteFill,
          {
            borderRadius: radius,
            borderWidth: 1,
            borderTopColor: 'rgba(255,255,255,0.50)',
            borderLeftColor: 'rgba(221,241,255,0.28)',
            borderRightColor: 'rgba(221,241,255,0.16)',
            borderBottomColor: 'rgba(221,241,255,0.12)',
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
      tint={active ? 'rgba(185,226,255,0.54)' : 'rgba(15,24,34,0.56)'}
    >
      {children}
    </Glass>
  );
}
