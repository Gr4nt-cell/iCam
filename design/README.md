# iCam current interface and recording pipeline

The main interface uses black surroundings, smoked glass controls and yellow accents. The rear interface follows the supplied Xiaomi reference: a portrait viewfinder beside a narrow control column, gallery / zoom / beauty / shutter controls, bottom mode labels and a top chevron returning to the front screen. A low-cost soft gradient fills the spare background; no live full-screen blur pass is added.

The screen switch is shown only for detected built-in rear-sized displays. External, Wi-Fi, virtual and overlay displays are excluded. Rear mode mirrors preview, saved photos and recorded video, with local focus coordinates matching the smaller viewfinder. Main-screen mirror preferences remain separate. Root is an explicit optional fallback; correctly provisioned privileged builds use their granted task permission before Shizuku or root. See rear-screen.md and ../system-integration/README.md.

SDR video tone, denoise, skin smoothing, stabilization and crop run on the live GPU path before encoding. Supported ordinary rear-camera EIS is not cropped a second time. Other SDR paths use causal motion / roll filters and a small selfie crop. Horizon works in SDR, including the front camera, with enough crop to cover rotated edges. The 8-bit processor rejects 10-bit input.

HDR records directly through CameraX's 10-bit path with supported hardware EIS / OIS while recording. Unsupported HDR EIS combinations retry the same HDR range with optical stabilization where available and report the limitation. HDR is not silently converted to SDR. Live HDR Horizon lock is unavailable: choose SDR for Horizon. Settings preserve an HDR choice and migrate an old HDR+Horizon combination to Cinema.

Stop now emits the finalized encoded file directly. There is no automatic whole-clip stabilization export or offline motion scan after Stop. Encoder / muxer finalization and the gallery copy remain. Clips with camera switches may still require joining; recording is locked until that join completes. Old offline helper classes and their mathematical tests are retained as inactive reference code.

Photo and Portrait share detected-face skin smoothing on both cameras (initial 45%, adjustable under Look / Skin). Video smoothing is separate. Existing modes, HDR capture, lens selection and offline image processing remain available on the main screen.

Validation includes TypeScript, the actual photo shader, capture/control regression checks, manifest mods, rear layout / mirroring policy, rear display detection, root task ownership and live roll / crop math. The live GL processor and display access classes compile against their Android dependencies. Full APK compilation and physical Xiaomi testing are still required before release.
