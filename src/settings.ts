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
