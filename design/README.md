# iCam: capture processing and grouped modes

Photo and Video are the two main tabs. Each has a separate subtype row:

- Photo: Standard, Portrait, Night Sight, Macro (when supported), Pro.
- Video: Standard, Slo-mo and Dual (when supported), Action, Pro video.

Pro's photo/video toggle remains available. All spring animations and overshoot have been replaced with fixed-duration transitions. Scroll containers do not bounce. The gallery and flip controls are anchored to the shutter row so the additional subtype row cannot overlap them.

## Stabilization and framing

Both SDR and HDR disable CameraX electronic preview/video stabilization to avoid stacking a camera crop with the processing crop. Optical stabilization can still assist. Front-camera processing reserves are smaller: 1.02x standard/cinematic/Horizon, 1.08x Action, with extra geometry only when required by roll. Camera flips reset manual zoom to 1x; Dual does not force a selfie zoom.

SDR processing happens live in PortraitProcessor. HDR capture stays wide and records HLG or HDR10. After recording, disposable 160x90 proxies measure motion; the full-resolution HDR frames are transformed through Media3's HDR pipeline and exported as HEVC with HDR_MODE_KEEP_HDR. Proxy pixels never become output video pixels. Gravity samples for Action/Horizon use the recorded timeline with pauses excluded. Transforms interpolate at the original frame rate. Cropping accounts for both translation and roll to avoid black corners.

HDR processing needs Android 13+ and a compatible HDR decoder, GPU and HEVC encoder. Unsupported HDR exports, tone-mapping fallbacks, processing errors, or mismatched output colour metadata/resolution retain the original recording and show a message. No automatic conversion to SDR is accepted. HDR processing occurs after stop, so its viewfinder shows the uncropped capture rather than the final stabilized framing. Recording is disabled while that export completes.

## Per-phone hardware tuning

For video, iCam filters the CameraX-exposed front cameras to recordable candidates, checks HLG/HDR10 capability when requested, and ranks supported candidates by estimated video field of view from sensor size, focal length and zoom-out range. If a wider lens rejects the full session, it retries the default front camera. It never forces a hidden camera ID.

Selfie video 1x maps to the selected lens's actual minimum zoom (including values below native 1x); manual zoom scales from that baseline. The preview fits the full frame. Source switching clears old digital zoom, motion and roll crops. Quality selection and frame cadence are based on the selected camera, not an intersection with the other camera. The 16:9 output format is retained. Pro controls check manual sensor/postprocessing capability and supported WB/focus/exposure ranges before applying overrides. Pro video routes to video capture with its manual controls enabled. HDR is exposed in settings and forwarded to native capture; explicitly saved choices are retained.

These are runtime checks performed on the installed phone. No connected phone hardware was inspected in this workspace.

## Photo quality

Photo finishing uses restrained colour, limited sharpening and JPEG quality 97. Detected-face smoothing feathers boundaries, preserves complexion and protects facial features. SDR video tone adaptation limits highlight brightening and uses small neutral-sample white-balance corrections. This does not recover already-clipped sensor detail.

## Validation

- TypeScript type check, actual Skia photo shader rendering and mode grouping checks pass.
- Eighteen Kotlin tests pass: crop policy, motion estimation, tone limits, interpolation, pause timing, mirror direction coverage of transformed frame corners, hardware-relative zoom and lens field-of-view ranking.
- The HDR processor and geometry compile against Android API 34 classes and the exact Media3 1.4.1 dependencies. The hardware selector compiles against CameraX 1.5.1.
- The scoped preservation audit confirms 143 unaffected control bindings. Authorized HDR callbacks, grouped controls and motion changes are scoped separately.
- Full Android app compilation, HDR export on a physical phone and front/rear walking footage still require verification. No APK was built for this revision.

The CI workflow compiles the complete Android camera module and runs its tests. The older Figma and preview artwork in this folder represent an earlier interface, not the updated grouped controls or evidence of capture quality.
