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
