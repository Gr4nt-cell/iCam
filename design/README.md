# iCam: capture processing and grouped modes

Photo and Video are the two main tabs. Each has a separate subtype row:

- Photo: Standard, Portrait, Night Sight, Macro (when supported), Pro.
- Video: Standard, Slo-mo and Dual (when supported), Action, Pro video.

Pro's photo/video toggle remains available. All spring animations and overshoot have been replaced with fixed-duration transitions. Scroll containers do not bounce. The gallery and flip controls are anchored to the shutter row so the additional subtype row cannot overlap them.

## Stabilization and framing

Ordinary rear SDR video now uses CameraX electronic stabilization when the selected camera supports it. That path receives no second processing crop. If hardware EIS cannot bind, the exporter provides a software fallback. Front capture stays wide without hardware EIS; it uses a small processing margin (1.06x Standard, 1.08x Cinema, 1.12x Action). Rear software reserves are 1.10x Standard, 1.16x Cinema, 1.28x Action. Horizon may need more crop to keep rotated corners covered.

Software stabilization runs after stop for both SDR and HDR. Aspect-correct proxies feed corner selection, pyramidal optical flow, backward verification and robust affine consensus. Full-resolution output uses only rigid translation / roll and a constant crop, avoiding affine stretching. Offline symmetric smoothing uses future frames; brief tracking gaps do not reset the path. Normal roll comes from the recorded gravity trace, since image-only roll is ambiguous during perspective pans. Action/Horizon use gravity for absolute leveling. Clips with too few reliable tracks retain the original.

SDR exports as AVC. HDR stays HLG/HDR10 through Media3's high-precision pipeline and HEVC export; unsupported HDR editing retains the original. Export runs after stop with the existing processing indicator. Captured frames and their measurement proxies stay separate.

Photo and Portrait now share a separate adjustable face-smoothing setting on both front and rear cameras. Its initial strength is 45%; an existing positive skin setting migrates, and an explicitly saved new Off setting is preserved. This setting does not alter video, Pro, Night or Macro defaults. Both modes use the same detected-face smoothing shader; Portrait additionally adds depth blur.

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
