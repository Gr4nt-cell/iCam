import type { CaptureMode } from './hardware';

export type ModeGroup = 'photo' | 'video';
const VIDEO_KEYS = new Set<CaptureMode>(['video', 'slowmo', 'dual', 'action', 'pvideo']);

export function modeGroup(mode: CaptureMode, proVideo = false): ModeGroup {
  return VIDEO_KEYS.has(mode) || (mode === 'pro' && proVideo) ? 'video' : 'photo';
}

/** Pro remains available in both groups; capability-filtered modes stay filtered. */
export function modesForGroup(modes: { key: CaptureMode; label: string }[], group: ModeGroup) {
  const order: CaptureMode[] = group === 'video'
    ? ['video', 'slowmo', 'dual', 'action', 'pvideo', 'pro']
    : ['photo', 'portrait', 'night', 'macro', 'pro'];
  return order.flatMap((key) => {
    const mode = modes.find((item) => item.key === key);
    return mode ? [{ ...mode, label: key === group ? 'Standard' : key === 'pro' && group === 'video' ? 'Pro video' : mode.label }] : [];
  });
}
