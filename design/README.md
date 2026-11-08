# iCam: capture processing and grouped modes

Photo and Video are the two main tabs. Each has a separate subtype row:

- Photo: Standard, Portrait, Night Sight, Macro (when supported), Pro.
- Video: Standard, Slo-mo and Dual (when supported), Action, Pro video.

Pro's photo/video toggle remains available. All spring animations and overshoot have been replaced with fixed-duration transitions. Scroll containers do not bounce. The gallery and flip controls are anchored to the shutter row so the additional subtype row cannot overlap them.

## Stabilization and framing

Both SDR and HDR disable CameraX electronic preview/video stabilization to avoid stacking a camera crop with the processing crop. Optical stabilization can still assist. Front-camera processing reserves are smaller: 1.06x standard, 1.10x cinematic, 1.16x Action, 1.08x Horizon, with extra geometry only when required by roll. Camera flips reset manual zoom to 1x; Dual does not force a selfie zoom.

SDR processing happens live in PortraitProcessor. HDR capture stays wide and records HLG or HDR10. After recording, disposable 160x90 proxies measure motion; the full-resolution HDR frames are transformed through Media3's HDR pipeline and exported as HEVC with HDR_MODE_KEEP_HDR. Proxy pixels never become output video pixels. Gravity samples for Action/Horizon use the recorded timeline with pauses excluded. Transforms interpolate at the original frame rate. Cropping accounts for both translation and roll to avoid black corners.

HDR processing needs Android 13+ and a compatible HDR decoder, GPU and HEVC encoder. Unsupported HDR exports, tone-mapping fallbacks, processing errors, or mismatched output colour metadata/resolution retain the original recording and show a message. No automatic conversion to SDR is accepted. HDR processing occurs after stop, so its viewfinder shows the uncropped capture rather than the final stabilized framing. Recording is disabled while that export completes.

## Photo quality

Photo finishing uses restrained colour, limited sharpening and JPEG quality 97. Detected-face smoothing feathers boundaries, preserves complexion and protects facial features. SDR video tone adaptation limits highlight brightening and uses small neutral-sample white-balance corrections. This does not recover already-clipped sensor detail.

## Validation

- TypeScript type check, actual Skia photo shader rendering and mode grouping checks pass.
- Fourteen Kotlin tests pass: crop policy, motion estimation, tone limits, interpolation, pause timing, mirror direction and coverage of transformed frame corners.
- The HDR processor and geometry compile against Android API 34 classes and the exact Media3 1.4.1 dependencies.
- The scoped preservation audit confirms 143 unaffected control bindings. Authorized HDR callbacks, grouped controls and motion changes are scoped separately.
- Full Android app compilation, HDR export on a physical phone and front/rear walking footage still require verification. No APK was built for this revision.

The CI workflow compiles the complete Android camera module and runs its tests. The older Figma and preview artwork in this folder represent an earlier interface, not the updated grouped controls or evidence of capture quality.
