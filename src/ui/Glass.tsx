import { BlurView } from 'expo-blur';
import { LinearGradient } from 'expo-linear-gradient';
import React from 'react';
import { Platform, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

type Props = {
  style?: StyleProp<ViewStyle>;
  radius?: number;
  intensity?: number;
  tint?: string;
  children?: React.ReactNode;
};

/** Neutral smoked glass. Android camera surfaces use a static sheen to avoid preview readback. */
export function Glass({ style, radius = 26, intensity = 28, tint = 'rgba(30,30,28,0.58)', children }: Props) {
  return (
    <View style={[{ borderRadius: radius, overflow: 'hidden' }, style]}>
      {Platform.OS !== 'android' ? <BlurView intensity={intensity} tint="dark" pointerEvents="none" style={StyleSheet.absoluteFill} /> : null}
      <View pointerEvents="none" style={[StyleSheet.absoluteFill, { backgroundColor: tint }]} />
      <LinearGradient pointerEvents="none"
        colors={['rgba(255,255,248,0.20)', 'rgba(255,255,255,0.045)', 'rgba(255,255,255,0.015)', 'rgba(255,255,245,0.075)']}
        locations={[0, 0.28, 0.70, 1]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={StyleSheet.absoluteFill} />
      <View pointerEvents="none" style={[StyleSheet.absoluteFill, {
        borderRadius: radius, borderWidth: 1,
        borderTopColor: 'rgba(255,255,246,0.48)', borderLeftColor: 'rgba(255,255,255,0.24)',
        borderRightColor: 'rgba(255,255,255,0.10)', borderBottomColor: 'rgba(255,255,255,0.09)',
      }]} />
      {children}
    </View>
  );
}

export function GlassCircle({ size = 44, children, active }: { size?: number; children?: React.ReactNode; active?: boolean }) {
  return <Glass radius={size / 2} style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }}
    tint={active ? 'rgba(117,108,42,0.52)' : 'rgba(35,35,32,0.58)'}>{children}</Glass>;
}
