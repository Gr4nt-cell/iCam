# iCam source audit — 2026-11-09

Baseline: `e3c785044990c111aac2643db996dee992ee0339` on `Gr4nt-cell/iCam/main`.

Reviewed the camera screen and controls, photo processing queue, permission and preference loading, native photo/recording lifecycle, MP4 completion/joining, external-camera intents, rear-display routing and GL surface rendering. Existing stabilization, native HDR, mirroring, smoothing and rear-screen designs remain in place.

## Verified defects addressed

| Trigger | Defect | Correction |
|---|---|---|
| Stabilization/control fallback notice during a recording | Every native notice reset the JS recording/busy flags, even while the recorder continued | Notices only display a message; recording events and command failures own recording state |
| Photo request fails to emit an event | Shutter could remain busy indefinitely | Bounded photo requests, request IDs, cancellation and rejection handling |
| Late event after a capture timeout | Could resolve a newer request with the wrong photo | Native/JS request correlation ignores stale events |
| Repeated shutter/palm input or a timer surviving backgrounding | Concurrent captures, overwritten waiters or an unexpected delayed capture | Single-flight shutter gate and cancellable countdown generation |
| Stop/background/detach during the start sound | Delayed native callback could still start recording | Cancellable generation tokens, including Dual start, plus active-view checks |
| Stop while changing cameras, or backgrounding during a switch | A continuation could restart recording after Stop | Continuations honor the stopped/inactive/detached state |
| Recording start throws after awake flags are set | Display could remain pinned awake | Roll back recording/timeline/awake state on start failure |
| One photo-processing job rejects | Later queued photos could be skipped | Recoverable serial queue; each capture reports its own failure |
| Previous photo finishes processing after a newer capture | Could replace the latest thumbnail | Update only the latest successful capture identity |
| Gallery read permission is denied on recent Android | App skipped a permitted write and still said Saved | Attempt the actual media write and require a confirmed asset ID |
| Processing or gallery write fails | Fallback metadata/local video could become inaccessible | Retain local capture URIs and use a scoped FileProvider for opening them |
| Pause/resume command fails | UI optimistically showed the wrong pause state | Native Pause/Resume events are authoritative |
| Permission changed in system settings | Microphone/camera state stayed stale until restart | Refresh on foreground and handle failed permission prompts |
| Restored JSON is null, malformed in shape, out of range or from another camera capability set | Could crash startup or send invalid native props | Validate stored preferences and fall back from unavailable modes |
| Reset/Remember settings | Skin/bokeh and other settings were omitted; timer/flash were not remembered | Complete defaults reset, timer/flash persistence and disabled-persistence cleanup |
| External camera intent destination cannot be opened | Could return success without writing the capture | Require a valid stream, publish MediaStore video after copying, remove failed insertion, finish the activity on main |
| Very high-resolution photo requested without an output URI | Fixed sample size could return an oversized Binder bitmap | Bound returned intent thumbnails to 320-pixel longest edge |
| Recorder writes only an MP4 header or joined output contains no video | Nonempty files were accepted and original segments could be deleted | Require a video track with a sample; preserve original clips after invalid joins |
| GL context cannot be made current | Renderer proceeded with GL calls anyway | Return before drawing and handle released texture reads |
| Rear-display main-thread dispatch times out | Queued move could execute after the caller had given up | Cancel timed-out dispatch and remove its queued callback |
| Wide portrait window | Bottom deck width clamp disagreed with the explicitly sized shutter row | Use one consistent screen-relative deck width |

## Validation and limits

- TypeScript and existing photo, smoothing, mode, rear-screen, framing and live-video regression checks.
- JavaScript failure-path tests: timeout/stale callback, cancellation before dispatch, exclusive capture, queue rejection recovery, non-fatal notices, local video recovery and invalid preferences.
- 35 deterministic Kotlin tests, including delayed-recording tokens and high-resolution intent thumbnail bounds.
- Android native compilation, unit tests and lint run in the PR workflow. A lint report is retained with that workflow.
- Signed release build, archive/manifest/signature verification and 16 KB page-size checks are required before APK delivery.

This review fixes the defects identified above; it does not establish that every possible bug is eliminated. Real-device saved-video playback, audio, thermal/UI frame cadence, OEM camera combinations, root/Shizuku services and repeated physical rear-display moves require device testing. No iPhone-relative stabilization claim is made. Models used by both CPU and accelerator inference were retained. Potentially unsaved capture files are not bulk-deleted.
