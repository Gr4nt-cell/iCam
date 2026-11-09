# Xiaomi-style rear screen

The toolbar screen icon appears only when a small built-in secondary display is detected. Known external / Wi-Fi / virtual / overlay types are rejected, including private virtual displays. When the type API is hidden, detection conservatively requires a private rear/built-in-labelled display of rear-screen dimensions. Unidentified displays do not expose the feature. No rear display ID is hardcoded.

The rear interface uses a portrait preview pane, a soft lightweight background, bottom Video / Photo / Portrait / Action labels, a gallery button, one zoom bubble, a beauty slider button and the shutter. During recording the beauty button becomes pause / resume. Long-press zoom to flip camera lenses. The top chevron returns to the front screen. Advanced settings remain on the front. Focus is mapped to the viewfinder's actual rectangle, including mirrored preview coordinates.

Rear mode forces selfie-style mirroring for both front and rear camera preview, processed photos and video. Photo metadata prevents a second flip when the camera already mirrored the JPEG. CameraX MirrorMode.ON handles encoded rear video, including the 10-bit HDR path. Moving back to the main screen restores the normal mirror preference.

Access order is normal Android display launch, actual granted MANAGE_ACTIVITY_TASKS system privilege, authorised Shizuku, then an explicitly enabled root fallback. Root is never requested at startup. The root manager may prompt when Use root fallback is tapped. The root command parser identifies only iCam's own task and refuses roots containing another app. Fixed commands move that task and wake only the chosen display; user-provided shell commands are not accepted.

For system integration, install a privileged app and its matching permission / hidden-API configuration as described in ../system-integration/README.md. A normal system-app flag does not grant these privileges, and the app does not grant them to itself. OEM policy can still refuse display access. Keep the phone unlocked and enable its rear screen in HyperOS settings.

Switching is blocked during recording, countdowns and saving, and capture is blocked during a pending move. The activity remains a single resizable task and handles density / size changes. Actual rear preview orientation, encoded mirroring, touch mapping, root manager prompts, system allowlisting and screen transitions must be tested on hardware. No Xiaomi hardware verification or APK build was performed here.


### Rear viewfinder fills the display

The rear image begins at the left edge and extends to a 54–96 dp right control rail. It is no longer constrained to a portrait 3:4 rectangle on a landscape rear panel. CameraX fills this wider view with a display-only crop; photo processing and the video recorder keep the chosen capture format and resolution. Tap-to-focus uses the expanded camera-local rectangle and excludes the rail. Gallery, shutter, mode strip, zoom and front-screen return controls remain available. At the reported 976×596 window, the preview is 880×596 rather than 447×596 with a 419-pixel blank section.
