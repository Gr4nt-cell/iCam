import { registerRootComponent } from 'expo';
import React, { useEffect, useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';

/**
 * Startup guard: anything that throws while the app loads (a native library failing to
 * initialise, an import-time error) is shown on screen instead of closing the app.
 */
type Listener = (e: unknown) => void;
const listeners = new Set<Listener>();
let firstError: unknown = null;

function report(e: unknown) {
  if (!firstError) firstError = e;
  listeners.forEach((l) => l(e));
}

const g = global as any;
const previous = g.ErrorUtils?.getGlobalHandler?.();
g.ErrorUtils?.setGlobalHandler?.((e: unknown, isFatal?: boolean) => {
  report(e);
  if (!isFatal && previous) previous(e, isFatal);
});

// Camera UI is portrait; locked at runtime (not in the manifest) so large-screen devices aren't restricted
try {
  const SO = require('expo-screen-orientation');
  SO.lockAsync(SO.OrientationLock.PORTRAIT_UP).catch(() => {});
} catch {}

// Show a crash recorded on the previous run (native side writes it before the app closes)
try {
  const crash = require('./modules/icamera').takeLastCrash();
  if (crash) report(new Error(`Previous launch crashed:\n\n${crash}`));
} catch {}

let App: React.ComponentType | null = null;
try {
  App = require('./App').default;
} catch (e) {
  report(e);
}

function describe(e: unknown) {
  const err = e as { message?: string; stack?: string };
  const msg = err?.message ?? String(e);
  if (msg.startsWith('Previous launch crashed')) return msg;
  return `${msg}\n\n${String(err?.stack ?? '').slice(0, 4000)}`;
}

function Root() {
  const [error, setError] = useState<unknown>(firstError);
  useEffect(() => {
    const l: Listener = (e) => setError((prev: unknown) => prev ?? e);
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  }, []);

  if (error || !App) {
    return React.createElement(
      View,
      { style: { flex: 1, backgroundColor: '#000', padding: 24, paddingTop: 72, gap: 12 } },
      React.createElement(Text, { style: { color: '#fff', fontSize: 22, fontWeight: '700' } }, 'iCam ran into a problem'),
      React.createElement(
        Text,
        { style: { color: 'rgba(255,255,255,0.7)' } },
        'Please screenshot this screen and send it so it can be fixed.',
      ),
      React.createElement(
        ScrollView,
        { style: { flex: 1, backgroundColor: 'rgba(255,255,255,0.06)', borderRadius: 16, padding: 12 } },
        React.createElement(
          Text,
          { selectable: true, style: { color: '#ffb4ab', fontFamily: 'monospace', fontSize: 12 } },
          describe(error ?? new Error('App module did not load')),
        ),
      ),
      React.createElement(
        Pressable,
        {
          onPress: () => {
            firstError = null;
            setError(null);
          },
          style: { backgroundColor: '#8ab4f8', borderRadius: 22, height: 46, alignItems: 'center', justifyContent: 'center' },
        },
        React.createElement(Text, { style: { color: '#0b1f44', fontWeight: '700' } }, 'Try again'),
      ),
    );
  }
  return React.createElement(App);
}

registerRootComponent(Root);
