# Stabilization replacement and wide framing

The former block matcher, integrated camera path, roll filter, per-output crop envelope and dormant offline exporters have been removed. SteadyFrame.kt is the new live implementation.

The fallback chooses corners across a 6×4 grid, searches a two-level image pyramid with exposure-normalised patch error, rejects forward/backward mismatches, and estimates background translation by consensus. A time-based pan-velocity controller spends the fixed capture margin on shake, damps uncertain observations and soft-limits at the boundary. Camera timestamp gaps and lens changes reset the path. The current frame's luma is read after drawing its small proxy; correction is applied to that frame rather than a previous frame's proxy. This synchronous readback is small but still requires profiling on physical devices.

One sensor-space transform handles crop, roll and translation in the output shader. It is sampled by both CameraX output surfaces; mirror/rotation metadata is applied by CameraX, rather than a separate stabilization history for each output. Common-stream CameraX stabilization is preferred when supported. Hardware-stabilized inputs receive no additional software stabilization crop. HDR retains native 10-bit stabilization; it never passes through the 8-bit effect.

Software margins: Standard 1.04×; Cinema 1.08× rear / 1.05× front; Action 1.12× rear / 1.08× front; Horizon 1.10× rear / 1.06× front. Off is 1×. This replaces the old Action 1.28× crop plus additional rotation zoom. Horizon keeps its fixed margin, so large tilts can show black corners instead of increasing zoom. Normal modes bound roll and translation so their margin does not expose corners. These margins reserve space; they cannot deliver unlimited motion cancellation.

All PreviewViews now fit the complete stream, including dual and rear-screen layouts. Photo front-camera 1× uses the selected camera's minimum zoom, like video. The old Full setting becomes SENSOR (4:3), including saved photos, rather than cropping to a tall phone/rear-display rectangle. Square/16:9 remain intentional output crops. Video previews explicitly request the recording aspect. Lens choice and user zoom remain available.

Validation covers known translation with exposure shifts, motion beyond the previous search radius, blank scenes, stationary drift, simulated walking-frequency jitter, discontinuities, fixed crop, geometric edge containment, hardware selection and the encoder delivery guard. This is deterministic testing, not a quality measurement from a rebuilt phone recording. Existing unrelated control bindings, photo smoothing, mode groups, rear routing, HDR separation and mirroring are audited.

Physical tests still required: front/rear, 30/60 fps, HDR, Action/Horizon, locked/rear displays, lens switching, low light, moving foregrounds, deliberate pans and walking. Check saved video against preview, black corners, rolling-shutter wobble, sustained frame rate, heat and audio sync. Existing motion blur and parallax cannot be removed by this rigid transform.

## CameraX flag correction after device report

CameraX 1.5.1 distinguishes unspecified from explicit OFF. Its Preview.Builder contract states that Preview ON + VideoCapture OFF disables stabilization for both streams. The former two-Boolean plan produced that exact combination; the resulting toast incorrectly attributed it to the phone. Video-only fallback had the opposite conflict (Preview OFF + VideoCapture ON).

Plans now preserve three states. Shared stabilization sets Preview ON and leaves VideoCapture unspecified. Native video-only stabilization leaves Preview unspecified and sets VideoCapture ON. Software/Off paths set both OFF intentionally. All primary and conservative fallback builders use those states. The runtime watchdog still reports genuinely unconfirmed hardware output, without accusing the phone or claiming a physically tested result. Requested 4K/60 is retained; the screenshot alone does not establish that the phone cannot support it.

Regression coverage asserts the actual setter calls emitted by the plans, including omission of the opposing OFF flag. Static binding checks enforce those adapters on every recording builder. Reference: https://developer.android.com/reference/androidx/camera/core/Preview.Builder#setPreviewStabilizationEnabled(boolean)


## Larger viewfinder and rigid-motion fallback

The main camera now uses an explicit capture-ratio rectangle: portrait video/16:9 photo is 9:16, sensor/4:3 photo is 3:4, and square photo is 1:1. Only square intentionally crops the native preview, matching the saved photo. The controls reserve 176 dp in portrait; landscape uses a side rail. Zoom sits over the image. The shutter is 64 dp and gallery/flip controls are 44 dp. Focus coordinates and the dual inset are relative to the same camera rectangle. Exposure, filters/skin, timer and flash/light live in Camera settings.

Horizon lock is removed from the UI, native API and processor. Older saved values migrate to Cinema. The software fallback estimates a rigid image transform from distributed corner matches, rejecting foreground motion with pairwise consensus. It handles roll shake as well as translation and uses a time-based pan-following controller. The search handles larger inter-frame displacement. Correction uses the same current-frame transform for preview and encoder and the existing fixed crop. Hardware EIS still has no stacked software crop; HDR remains native 10-bit.

Validation includes 20 viewport configurations (small/tall portrait and landscape, all capture ratios), legacy setting migration, native focus placement, 24 Kotlin tests including combined roll/translation, foreground occlusion, pan settling, and roll-shake residuals at 30/60 fps. These are deterministic synthetic motion tests, not proof of physical-device or iPhone-relative quality. Physical saved recordings in daylight, low light, front/back and 4K/60 remain necessary.


## Compact controls, full-width video and safe display handoff

Zoom selector is 28 dp tall (plus its glass padding), and top instruments use 34–36 dp capsules. The mode label sits between them. The bottom deck has an explicit screen-relative width and gallery/shutter/flip centers at 18%/50%/82%, eliminating intrinsic-width/animation alignment dependence.

Video now uses the full available width at its true 16:9 ratio; on short windows controls overlay the image rather than squeezing its width. Zoom stays above the lower control deck. Square and sensor photos keep their selected frame ratios.

Rear/front buttons switch directly using fresh display status. Help appears only when access is needed; existing Shizuku/system access and an explicitly enabled root preference are reused. The camera is quiesced on the main thread before moving the task. Rebinds are blocked while moving, verification uses the current activity after recreation, and surfaces are rebuilt afterward. GL input textures remain owned by their SurfaceRequest result callbacks; context destruction waits until all inputs return. Repeated release is idempotent.

The UI requests up to 120 Hz from the current display without choosing another resolution or changing recording frame rate. API 35+ UI views cast a refresh-rate vote, excluding the camera's native surface subtree. The request is reapplied after foregrounding and display moves, with fallback for 60/90 Hz displays. This is a refresh request, not a measured guarantee of sustained 120 fps; OS power/thermal policy and frame workload still apply. Reference: https://developer.android.com/develop/ui/views/animations/adaptive-refresh-rate

Validation includes 30 Kotlin tests (motion/policies, surface retirement callback order, idempotent release and refresh selection), hook tests for one-tap targets, duplicate taps and rejected moves, viewport ratio/full-width guards, and preserved capture/save/recording callbacks. The physical HyperOS crash and delivered UI frame cadence still need confirmation on the device.
