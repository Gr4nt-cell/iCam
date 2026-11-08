# iCam camera redesign and capture quality

The camera uses black surroundings, compact smoked-glass controls, warm edge highlights and yellow selection accents, following the supplied camera photos. A white photo shutter or red recording button sits above a Photo/Video selector, with thumbnail and flip controls alongside. The grid button opens all existing modes. Android glass uses a static sheen to avoid repeatedly blurring the live camera feed.

## Capture changes

- Front and rear cameras share the stabilization crop policy. Action reserves more crop space; Horizon also levels the front camera. Rotation crop expands immediately to prevent exposed corners and relaxes gradually. Motion estimates compensate for exposure changes and reject local outliers. Fixed frame cadence is preferred when supported.
- SDR tone adaptation limits brightening around highlights, smooths exposure transitions and makes small white-balance corrections only when neutral samples are available. Manual white-balance presets remain respected. These changes do not add HDR10 recording or recover clipped sensor detail.
- Photo finishing uses restrained colour, neighbourhood-limited sharpening and JPEG quality 97. Adjustable skin smoothing uses detected face regions, feathers the boundary, protects edges and preserves complexion rather than whitening skin. Video smoothing also protects edges and retains texture.

## Validation

`npm run typecheck`, `node scripts/check-photo-look.cjs`, and the control-preservation audit pass. Seven standalone Kotlin unit tests cover crop bounds, frame cadence, motion estimation, smoothing and tone policies. The photo test compiles the actual Skia shader and checks noise reduction, complexion, facial contrast and unchanged background. The default preservation audit still rejects backend changes; this task uses its explicit `--allow-capture-quality` scope.

The pull-request workflow compiles the Android camera module and runs its unit tests without release signing. Physical-device camera validation is still required: test front/rear walking footage, Action, Horizon, low light, mixed lighting and multiple skin tones. Cropping cannot remove motion blur from a slow shutter, and results depend on camera hardware and available CameraX stabilization.

The older Figma import and reference files in this folder describe an earlier design. New preview artwork is a design mockup with sample viewfinder imagery, not an Android screenshot or evidence of capture quality. Browser rendering was unavailable because the browser executable could not launch in this workspace.
