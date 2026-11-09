# Current preview/encoder parity fix

The saved-file mismatch has two plausible code causes: treating a generic video-stabilization capability as proof that a custom SurfaceTexture input is stabilized, and retaining separate output crop histories. The new path prefers shared-stream stabilization, uses a single per-camera-frame envelope for every output, and counts successful processed encoder submissions. A capture-result check enables residual live image correction if the phone does not actually activate the requested shared mode.

A hardware test must compare the viewfinder and the saved clip from the same capture, for front/rear, Standard/Action/Horizon, 30/60 fps and HDR. Include stationary hold, walking, deliberate pan, pause/resume and camera switches. Check natural framing, no black corners, no breathing when recording starts, output playback and actual negotiated FPS. The delivery guard only detects missing processed submissions; it cannot measure final visual stability. HDR remains native 10-bit and does not use the SDR processor. Existing motion blur, rolling shutter and parallax remain limits.

Local validation: 45 Kotlin tests, standalone Android GL processor compilation, TypeScript and preservation/shader/static checks. No complete APK or rebuilt-phone recording was tested. The latest supplied night clip (15069.mp4) is 720x1280 at 60 fps. It cannot establish the mode or HAL stabilization state used to capture it.

---

# Archived offline replay — not the current live recording pipeline

The following measurements describe the earlier two-pass experiment. The current recording flow does not call this offline exporter. They are not performance claims for the live encoder path.

# Validation scope

The supplied files are portrait 1080x1920 AVC: 14899.mp4 contains 245 frames at approximately 30 fps; 14900.mp4 contains 559 frames at approximately 60 fps. The first is a selfie clip; the second pans across a room with nearby walls and motion blur.

The comparison replay runs the actual standalone Kotlin tracking and trajectory code on decoded aspect-correct proxies, then applies the same rigid transform geometry to frames. It is a desktop replay, not a recording made by a rebuilt app. Existing clips contain no iCam gravity trace, so replay leaves their roll unchanged. New app recordings collect gravity for normal roll smoothing and Action/Horizon leveling.

For the selfie replay, independent optical-flow measurement estimated fast translational motion RMS at 1.413 proxy pixels before and 0.199 after (180x320 analysis resolution, deliberate pan removed). This is an estimate for this clip, not a general quality guarantee. The 1.08x processing margin retains approximately 92.6% of each original dimension.

The rear software replay did not demonstrate a pixel-level improvement. It is not delivered as a successful stabilization preview. The source instead restores supported phone EIS for ordinary rear SDR recording and avoids a second software crop. That hardware path cannot be reproduced by reprocessing an existing file and still requires physical-device testing. Software fallback remains limited by parallax, tracking confidence and existing motion blur.

Checks cover the actual Skia smoothing shader, Photo/Portrait strength routing and saved Off state, all grouped modes, preserved unrelated controls, and pure Kotlin policies/geometry/tracking. The exporter compiles against Android API 34 classes and Media3 1.4.1. The complete Android app has not been compiled or run on a phone in this update. Test rear/front capture, gyro alignment, 30/60 fps, pauses, camera switches, Action, Horizon, HDR export, and multiple skin tones before release.
