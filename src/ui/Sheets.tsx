import { MaterialCommunityIcons } from '@expo/vector-icons';
import React, { useMemo, useState } from 'react';
import { Image, Modal, PanResponder, Pressable, ScrollView, StyleSheet, Switch, Text, useWindowDimensions, View } from 'react-native';
import type { Capabilities } from '../../modules/icamera';
import type { PhotoSettings, VideoSettings } from '../camera/hardware';
import { Glass } from './Glass';
import { GlassSegmented } from './GlassSegmented';

/* ---------------- Settings ---------------- */

type SettingsProps = {
  visible: boolean;
  onClose: () => void;
  photo: PhotoSettings;
  video: VideoSettings;
  onPhoto: (p: PhotoSettings) => void;
  onVideo: (v: VideoSettings) => void;
  supportsVideoHdr: boolean;
  bottomInset: number;
  mirrorSelfie: boolean;
  onMirrorSelfie: (v: boolean) => void;
  capabilities: Capabilities | null;
  remember: boolean;
  onRemember: (v: boolean) => void;
  onResetDefaults: () => void;
};

export function SettingsSheet(p: SettingsProps) {
  return (
    <Modal visible={p.visible} transparent animationType="slide" onRequestClose={p.onClose} statusBarTranslucent>
      <Pressable style={StyleSheet.absoluteFill} onPress={p.onClose} />
      <View style={[s.sheetWrap, { paddingBottom: p.bottomInset + 8 }]}>
        <Glass radius={32} style={s.sheet} tint="rgba(20,20,24,0.72)" intensity={70}>
          <View style={s.grabber} />
          <ScrollView contentContainerStyle={{ padding: 20, paddingTop: 8, gap: 18 }}>
            <Text style={s.title}>Settings</Text>

            <Section title="Photo processing">
              <Row label="Processing" hint="Single full-quality shot processed by your phone's own image engine (HDR, depth Portrait, Night) where available — no multi-frame merging" >
                <View />
              </Row>
              {p.capabilities?.nightExtension ? (
                <Row label="Phone's Night mode" hint="Use the phone maker's night processing in Night Sight">
                  <Toggle value={p.photo.vendorNight} onChange={(v) => p.onPhoto({ ...p.photo, vendorNight: v })} />
                </Row>
              ) : null}
            </Section>

            <Section title="Saved settings">
              <Row label="Remember settings" hint="Keep your mode, photo/video options, filters and Pro values next time">
                <Toggle value={p.remember} onChange={p.onRemember} />
              </Row>
              <Pressable onPress={p.onResetDefaults} style={s.resetBtn}>
                <Text style={s.resetText}>Reset everything to defaults</Text>
              </Pressable>
            </Section>

            <Section title="Selfie">
              <Row label="Mirror front camera" hint="Save selfie photos and videos as you see them in the viewfinder">
                <Toggle value={p.mirrorSelfie} onChange={p.onMirrorSelfie} />
              </Row>
            </Section>

            <Section title="Video">
              <Row label="Resolution">
                <Segmented
                  options={['1080p', '4k']}
                  labels={['1080p', '4K']}
                  value={p.video.resolution}
                  onChange={(v) => p.onVideo({ ...p.video, resolution: v as VideoSettings['resolution'] })}
                />
              </Row>
              <Row label="Frame rate">
                <Segmented
                  options={['30', '60']}
                  value={String(p.video.fps)}
                  onChange={(v) => p.onVideo({ ...p.video, fps: Number(v) as VideoSettings['fps'] })}
                />
              </Row>
              <Row
                label="Stabilization"
                hint={p.video.stabilization === 'horizon' ? 'Horizon lock keeps the horizon level even if you tilt or spin the phone (crops in, uses the ultrawide when available)' : undefined}
              >
                <Segmented
                  options={['off', 'standard', 'cinematic', 'horizon']}
                  labels={['Off', 'Std', 'Cinema', 'Horizon']}
                  value={p.video.stabilization}
                  onChange={(v) => p.onVideo({ ...p.video, stabilization: v as VideoSettings['stabilization'] })}
                />
              </Row>
              <Row
                label="HDR video"
                hint={p.supportsVideoHdr ? 'True 10-bit HDR for HDR screens. Looks dim on normal screens and skips the iCam low-light video processing and horizon lock' : 'Not supported by this camera'}
              >
                <Toggle
                  value={p.video.hdr && p.supportsVideoHdr}
                  disabled={!p.supportsVideoHdr}
                  onChange={(v) => p.onVideo({ ...p.video, hdr: v })}
                />
              </Row>
            </Section>

            <Section title="Camera hardware detected">
              {p.capabilities ? (
                <View style={s.hwCard}>
                  <Text style={s.hwTitle}>Advanced features</Text>
                  <Text style={s.hwLine}>Manual ISO / shutter / focus: {p.capabilities.manualSensor ? 'yes' : 'no'}</Text>
                  <Text style={s.hwLine}>Slow motion (high-speed): {p.capabilities.slowMotion ? 'yes' : 'no'}</Text>
                  <Text style={s.hwLine}>Dual front + back recording: {p.capabilities.concurrent ? 'yes' : 'no'}</Text>
                  <Text style={s.hwLine}>Phone maker Night mode: {p.capabilities.nightExtension ? 'yes' : 'no'}</Text>
                </View>
              ) : (
                <Text style={s.rowHint}>Reading camera hardware…</Text>
              )}
              {p.capabilities?.cameras.map((d) => (
                <View key={d.id} style={s.hwCard}>
                  <Text style={s.hwTitle}>
                    {d.position === 'back' ? 'Rear' : d.position === 'front' ? 'Front' : 'External'} camera · id {d.id}
                    {d.physicalCameras > 1 ? ` · ${d.physicalCameras} lenses` : ''}
                  </Text>
                  <Text style={s.hwLine}>
                    {d.maxPhotoMp} MP · video {d.videoQualities.join(' / ') || '—'} · up to {d.maxFps} fps
                  </Text>
                  <Text style={s.hwLine}>
                    Zoom {d.zoomMin.toFixed(1)}× – {d.zoomMax.toFixed(0)}× · EV {d.evMin.toFixed(1)} … {d.evMax.toFixed(1)}
                  </Text>
                  <Text style={s.hwLine}>
                    Level {d.hardwareLevel} · focal {d.focalLengths.map((f) => f.toFixed(1)).join(', ')} mm
                  </Text>
                  {d.isoMax ? (
                    <Text style={s.hwLine}>
                      ISO {d.isoMin}–{d.isoMax} · shutter {Math.round(1e9 / Math.max(1, d.exposureMinNs))
                        ? `1/${Math.round(1e9 / Math.max(1, d.exposureMinNs))}`
                        : '—'}{' '}
                      – {(d.exposureMaxNs / 1e9).toFixed(1)} s
                    </Text>
                  ) : null}
                  <Text style={s.hwLine}>
                    {[
                      d.videoHdr && 'HDR video',
                      d.previewStabilization && 'cinematic stabilization',
                      d.videoStabilization && 'video stabilization',
                      d.slowMotion && 'slow motion',
                      d.nightExtension && 'night mode',
                      d.raw && 'RAW',
                      d.flash && 'flash',
                    ]
                      .filter(Boolean)
                      .join(' · ') || 'basic'}
                  </Text>
                </View>
              ))}
            </Section>
          </ScrollView>
        </Glass>
      </View>
    </Modal>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View style={{ gap: 10 }}>
      <Text style={s.section}>{title}</Text>
      {children}
    </View>
  );
}

function Row({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <View style={s.row}>
      <View style={{ flex: 1, paddingRight: 10 }}>
        <Text style={s.rowLabel}>{label}</Text>
        {hint ? <Text style={s.rowHint}>{hint}</Text> : null}
      </View>
      {children}
    </View>
  );
}

function Toggle({ value, onChange, disabled }: { value: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <Switch
      value={value}
      disabled={disabled}
      onValueChange={onChange}
      trackColor={{ false: 'rgba(255,255,255,0.18)', true: '#8ab4f8' }}
      thumbColor="#fff"
    />
  );
}

function Segmented({
  options,
  labels,
  value,
  onChange,
}: {
  options: string[];
  labels?: string[];
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <View style={s.seg}>
      <GlassSegmented
        items={options.map((o, i) => ({ key: o, label: labels?.[i] ?? o }))}
        value={value}
        onChange={onChange}
        height={30}
        fontSize={13}
        paddingH={10}
      />
    </View>
  );
}

/* ---------------- Photo viewer with before/after ---------------- */

export function Viewer({
  visible,
  onClose,
  uri,
  originalUri,
  isVideo,
  info,
  onOpenGallery,
}: {
  visible: boolean;
  onClose: () => void;
  uri?: string;
  originalUri?: string;
  isVideo: boolean;
  info?: string;
  onOpenGallery?: () => void;
}) {
  const { width: W } = useWindowDimensions();
  const [split, setSplit] = useState(0.5);
  const [compare, setCompare] = useState(true);
  const canCompare = !!originalUri && originalUri !== uri;
  const pan = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: () => true,
        onPanResponderGrant: (e) => setSplit(Math.max(0, Math.min(1, e.nativeEvent.pageX / W))),
        onPanResponderMove: (e) => setSplit(Math.max(0, Math.min(1, e.nativeEvent.pageX / W))),
      }),
    [W],
  );

  return (
    <Modal visible={visible} animationType="fade" onRequestClose={onClose} statusBarTranslucent>
      <View style={s.viewer}>
        {isVideo ? (
          <View style={[StyleSheet.absoluteFill, { alignItems: 'center', justifyContent: 'center', gap: 12 }]}>
            <MaterialCommunityIcons name="check-circle-outline" size={64} color="#8ab4f8" />
            <Text style={s.viewerText}>Video saved to your gallery</Text>
          </View>
        ) : (
          <View style={StyleSheet.absoluteFill} {...(canCompare && compare ? pan.panHandlers : {})}>
            {/* Original underneath, processed on top clipped to the left of the divider */}
            {canCompare && compare ? (
              <Image source={{ uri: originalUri }} style={StyleSheet.absoluteFill} resizeMode="contain" />
            ) : null}
            <View style={[StyleSheet.absoluteFill, { width: canCompare && compare ? W * split : W, overflow: 'hidden' }]}>
              <Image source={{ uri }} style={{ width: W, height: '100%' }} resizeMode="contain" />
            </View>
            {canCompare && compare ? (
              <>
                <View pointerEvents="none" style={[s.divider, { left: W * split - 1 }]} />
                <View pointerEvents="none" style={[s.dividerKnob, { left: W * split - 18 }]}>
                  <MaterialCommunityIcons name="arrow-split-vertical" size={20} color="#fff" />
                </View>
                <Text pointerEvents="none" style={[s.tag, { left: 16 }]}>iCam</Text>
                <Text pointerEvents="none" style={[s.tag, { right: 16 }]}>Original</Text>
              </>
            ) : null}
          </View>
        )}
        <View style={s.viewerTop} pointerEvents="box-none">
          <Pressable onPress={onClose} hitSlop={10}>
            <Glass radius={22} style={{ width: 44, height: 44, alignItems: 'center', justifyContent: 'center' }}>
              <MaterialCommunityIcons name="close" size={22} color="#fff" />
            </Glass>
          </Pressable>
          <View style={{ flexDirection: 'row', gap: 10 }}>
          {onOpenGallery ? (
            <Pressable onPress={onOpenGallery} hitSlop={10}>
              <Glass radius={22} style={{ paddingHorizontal: 14, height: 44, alignItems: 'center', justifyContent: 'center' }}>
                <Text style={s.viewerText}>Open in Gallery</Text>
              </Glass>
            </Pressable>
          ) : null}
          {canCompare && !isVideo ? (
            <Pressable onPress={() => setCompare((c) => !c)} hitSlop={10}>
              <Glass radius={22} style={{ paddingHorizontal: 14, height: 44, alignItems: 'center', justifyContent: 'center' }}>
                <Text style={s.viewerText}>{compare ? 'Hide compare' : 'Compare'}</Text>
              </Glass>
            </Pressable>
          ) : null}
          </View>
        </View>
        {!isVideo && info ? (
          <View style={s.viewerBottom} pointerEvents="none">
            <Glass radius={18} style={{ paddingHorizontal: 16, paddingVertical: 9 }}>
              <Text style={s.viewerText}>{info}{canCompare && compare ? ' · drag to compare' : ''}</Text>
            </Glass>
          </View>
        ) : null}
      </View>
    </Modal>
  );
}

/* ---------------- Permission gate ---------------- */

export function PermissionGate({ onGrant, missing }: { onGrant: () => void; missing: string[] }) {
  return (
    <View style={[StyleSheet.absoluteFill, { backgroundColor: '#000', alignItems: 'center', justifyContent: 'center', padding: 24 }]}>
      <Glass radius={32} style={{ padding: 24, gap: 14, width: '100%', maxWidth: 380 }} tint="rgba(40,40,48,0.6)">
        <MaterialCommunityIcons name="camera-iris" size={44} color="#8ab4f8" />
        <Text style={s.title}>iCam needs access</Text>
        <Text style={s.rowHint}>
          To use every lens, record sound and save to your gallery, allow: {missing.join(', ')}.
        </Text>
        <Pressable onPress={onGrant} style={s.cta}>
          <Text style={s.ctaText}>Allow access</Text>
        </Pressable>
      </Glass>
    </View>
  );
}

const s = StyleSheet.create({
  sheetWrap: { position: 'absolute', left: 8, right: 8, bottom: 0, maxHeight: '82%' },
  sheet: { flexShrink: 1 },
  grabber: { alignSelf: 'center', width: 40, height: 5, borderRadius: 3, backgroundColor: 'rgba(255,255,255,0.4)', marginTop: 10 },
  title: { color: '#fff', fontSize: 22, fontWeight: '700' },
  section: { color: '#8ab4f8', fontSize: 13, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.8 },
  row: { flexDirection: 'row', alignItems: 'center', minHeight: 44 },
  rowLabel: { color: '#fff', fontSize: 15, fontWeight: '600' },
  rowHint: { color: 'rgba(255,255,255,0.6)', fontSize: 12, marginTop: 2 },
  seg: { backgroundColor: 'rgba(255,255,255,0.06)', borderRadius: 19 },
  segItem: { paddingHorizontal: 10, paddingVertical: 6, borderRadius: 11 },
  segActive: { backgroundColor: 'rgba(214,228,255,0.95)' },
  segText: { color: '#fff', fontSize: 13, fontWeight: '600' },
  segTextActive: { color: '#0b1f44' },
  hwCard: { backgroundColor: 'rgba(255,255,255,0.07)', borderRadius: 18, padding: 14, gap: 3 },
  hwTitle: { color: '#fff', fontSize: 14, fontWeight: '700', textTransform: 'capitalize' },
  hwLine: { color: 'rgba(255,255,255,0.72)', fontSize: 12 },
  viewer: { flex: 1, backgroundColor: '#000' },
  viewerTop: { position: 'absolute', top: 48, left: 16, right: 16, flexDirection: 'row', justifyContent: 'space-between' },
  divider: { position: 'absolute', top: 0, bottom: 0, width: 2, backgroundColor: 'rgba(255,255,255,0.9)' },
  dividerKnob: {
    position: 'absolute', top: '50%', width: 36, height: 36, marginTop: -18, borderRadius: 18,
    alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(255,255,255,0.22)',
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.7)',
  },
  tag: {
    position: 'absolute', bottom: 110, color: '#fff', fontSize: 12, fontWeight: '700',
    backgroundColor: 'rgba(0,0,0,0.35)', paddingHorizontal: 8, paddingVertical: 3, borderRadius: 8, overflow: 'hidden',
  },
  viewerBottom: { position: 'absolute', bottom: 48, left: 0, right: 0, alignItems: 'center' },
  viewerText: { color: '#fff', fontSize: 13, fontWeight: '600' },
  resetBtn: { alignSelf: 'flex-start', paddingVertical: 8 },
  resetText: { color: '#ff9f8f', fontSize: 14, fontWeight: '600' },
  cta: { backgroundColor: '#8ab4f8', borderRadius: 22, height: 46, alignItems: 'center', justifyContent: 'center', marginTop: 6 },
  ctaText: { color: '#0b1f44', fontSize: 16, fontWeight: '700' },
});
