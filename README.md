# iCam

A Pixel-style camera for Android with a Liquid Glass interface, built with Expo, a native CameraX module (`modules/icamera`) and Skia.

## What it does

**Photos — HDR+-style pipeline (`src/processing`)**
1. Shoots a burst of up to 4 frames, deliberately underexposed by 1 EV to protect highlights (Night Sight shoots at normal exposure with low-light boost).
2. Bakes in EXIF rotation and works at ≤ 4096 px on the long edge (~12 MP, like Pixel's binned output).
3. Aligns every frame to the first with a coarse-to-fine translation search (64 px → 256 px pyramids).
4. Robust temporal merge on the GPU: each frame is weighted by how closely it matches the reference, so noise averages out but moving subjects don't ghost.
5. Local tone mapping: a blurred base layer is compressed in log space (highlights held, shadows lifted) while fine detail is kept, followed by auto-exposure, filmic roll-off, vibrance, a slightly cool-neutral balance, a gentle S-curve and sharpening.
6. Saves to the gallery. Tap the thumbnail and hold the photo to compare against the original frame.

The **Brightness** and **Shadows** sliders (tap the viewfinder) work like Pixel's dual exposure controls: brightness drives the sensor's exposure, shadows feeds the tone mapper.

**Video — iOS-style capture settings**
- Up to 4K60, HEVC at the highest bitrate preset
- Cinematic-extended stabilization when the sensor supports it (falls back to cinematic → standard)
- 10-bit HDR video where available
- **Action** mode: 1080p60 with maximum stabilization

**Hardware detection**
- Picks the multi-lens logical rear camera so 0.5× / 1× / 2× / 5× pills switch physical lenses
- Chooses the best format per mode (12 MP 4:3 for photos, the requested resolution / fps / stabilization / HDR for video)
- Settings → *Camera hardware detected* lists every camera with lenses, megapixels, max video, fps, zoom and exposure range, HDR and stabilization support

**Permissions** (declared in `app.json`): camera, microphone, photos & videos read/write, media location, vibration.

## Building

Every push to `main` runs **.github/workflows/android.yml**, which installs dependencies, aligns Expo versions, type-checks, runs `expo prebuild` and builds a release APK (arm64). Download it from the run's **Artifacts** section on the Actions tab. You can also start it manually with *Run workflow*.

To build on expo.dev instead: `eas build -p android --profile preview`.

## Limits worth knowing

- Google's and Apple's real pipelines rely on RAW sensor access and proprietary models; this app reproduces the same techniques (burst merge, local tone mapping, stabilization/HDR capture) on processed frames.
- Portrait (depth) mode isn't included — it needs a segmentation model.
- On some phones Android can't blur the live preview behind the glass, so the glass falls back to a tinted frost.
