# Rear-screen camera interface

The camera toolbar gains a yellow screen icon when Android exposes an attached secondary display. Open it and select the rear display by its name and dimensions. Display IDs are discovered, not hardcoded to 1. The camera activity moves with its existing camera state; on entering the secondary display while idle it selects the rear camera at 1x. Lens flip remains a separate control.

The compact rear interface has a smoked-glass side rail with shutter / record / stop, pause / resume, lens flip and a Front button. Zoom and available capture modes scroll along the lower left. Existing tap focus, pinch zoom, photo smoothing, video processing and save callbacks remain shared with the main interface. Configure advanced settings on the front screen. The Front button requests display 0 directly. Recording, countdowns and media processing disable screen switching; a pending move also blocks capture.

## Xiaomi / HyperOS access

Android first tries ActivityOptions.launchDisplayId after checking display launch policy. HyperOS can expose Xiaomi 17 Pro / Pro Max's display while rejecting ordinary app launches. When this happens, the selector explains the restriction and offers an optional Shizuku connection. Install / start Shizuku using its official setup guide, allow iCam, then select the rear display again. The phone must be unlocked and its rear display enabled in system settings. A Shizuku permission is requested only by that explicit button.

The Shizuku user service checks the caller UID, finds only iCam's foreground root task, rejects roots shared with another task, and moves that root to the explicitly selected display. Its only shell input operation wakes that chosen display. It does not change screen timeout, density, orientation policy, system app state or another app's settings. A stopped Shizuku server does not prevent trying the ordinary public route back to the front.

The app never opens an unsolicited Presentation window, avoiding a crash when HyperOS rejects that window type. Refused / absent / disconnected displays leave a recoverable selector or message. An Expo manifest plugin keeps the main activity as one resizable task and handles density / size changes during a move. Shizuku's provider is permission protected and the service's reflective entry point is retained for release shrinking.

## Validation and limits

TypeScript, the Expo manifest mod / static integration checks and three display-policy unit tests are checked locally. The router and Shizuku user service are compiled against Android API 34 classes and Shizuku 13.1.5. This is source integration, not a successful Xiaomi hardware test or a built APK. Full Android build, release shrinking, actual screen transitions and camera preview on a Xiaomi 17 Pro Max remain unverified. OEM display policies can still refuse a shell-authorized move or reclaim the rear screen. This integration does not claim a public Xiaomi rear-screen SDK.

References: Android connected-display guide (https://developer.android.com/develop/adaptive-apps/guides/support-connected-displays), ActivityManager display policy (https://developer.android.com/reference/android/app/ActivityManager#isActivityStartAllowedOnDisplay(android.content.Context,int,android.content.Intent)), Shizuku API guide (https://github.com/RikkaApps/Shizuku-API), and the device-specific Mi Back Screen implementation (https://github.com/totallynotkasai/mi-back-screen).
