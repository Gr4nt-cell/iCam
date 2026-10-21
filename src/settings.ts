import { File, Paths } from 'expo-file-system';

/** Settings persisted between launches when "Remember settings" is on. */
const FILE = 'icam-settings.json';

export async function loadSettings<T extends object>(): Promise<Partial<T> | null> {
  try {
    const f = new File(Paths.document, FILE);
    if (!f.exists) return null;
    return JSON.parse(await f.text()) as Partial<T>;
  } catch {
    return null;
  }
}

export function saveSettings(data: object) {
  try {
    const f = new File(Paths.document, FILE);
    f.create({ overwrite: true });
    f.write(JSON.stringify(data));
  } catch {
    // best effort
  }
}

export function clearSettings() {
  try {
    const f = new File(Paths.document, FILE);
    if (f.exists) f.delete();
  } catch {
    // ignore
  }
}

/** Per-device facts learned at runtime (kept even when "Remember settings" is off). */
const DEVICE_FILE = 'icam-device.json';
export type DeviceFlags = { weakGpu?: boolean };

export async function loadDeviceFlags(): Promise<DeviceFlags> {
  try {
    const f = new File(Paths.document, DEVICE_FILE);
    if (!f.exists) return {};
    return JSON.parse(await f.text()) as DeviceFlags;
  } catch {
    return {};
  }
}

export function saveDeviceFlags(flags: DeviceFlags) {
  try {
    const f = new File(Paths.document, DEVICE_FILE);
    f.create({ overwrite: true });
    f.write(JSON.stringify(flags));
  } catch {
    // best effort
  }
}
