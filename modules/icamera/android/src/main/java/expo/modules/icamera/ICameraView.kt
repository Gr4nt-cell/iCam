package expo.modules.icamera

import android.Manifest
import android.annotation.SuppressLint
import android.content.Context
import android.content.pm.PackageManager
import android.hardware.camera2.CaptureRequest
import android.hardware.camera2.params.RggbChannelVector
import android.util.Range
import android.view.ViewGroup
import androidx.camera.camera2.interop.Camera2CameraControl
import androidx.camera.camera2.interop.CaptureRequestOptions
import androidx.camera.camera2.interop.ExperimentalCamera2Interop
import androidx.camera.core.Camera
import androidx.camera.core.CameraSelector
import androidx.camera.core.CompositionSettings
import androidx.camera.core.ConcurrentCamera
import androidx.camera.core.DynamicRange
import androidx.camera.core.FocusMeteringAction
import androidx.camera.core.ImageCapture
import androidx.camera.core.ImageCaptureException
import androidx.camera.core.MirrorMode
import androidx.camera.core.Preview
import androidx.camera.core.UseCaseGroup
import androidx.camera.extensions.ExtensionMode
import androidx.camera.extensions.ExtensionsManager
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.video.ExperimentalHighSpeedVideo
import androidx.camera.video.FallbackStrategy
import androidx.camera.video.FileOutputOptions
import androidx.camera.video.HighSpeedVideoSessionConfig
import androidx.camera.video.Quality
import androidx.camera.video.QualitySelector
import androidx.camera.video.Recorder
import androidx.camera.video.Recording
import androidx.camera.video.VideoCapture
import androidx.camera.video.VideoRecordEvent
import androidx.camera.view.PreviewView
import androidx.core.content.ContextCompat
import androidx.lifecycle.LifecycleOwner
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.viewevent.EventDispatcher
import expo.modules.kotlin.views.ExpoView
import java.io.File
import kotlin.math.ln
import kotlin.math.max
import kotlin.math.pow
import kotlin.math.roundToInt

/**
 * One CameraX surface for every capture mode:
 *  photo  – preview + still capture; JS asks for bursts that feed the HDR+ merge
 *  night  – vendor Night extension when the phone has one, else a burst
 *  pro    – manual ISO / shutter / white balance / focus via Camera2 interop, photo + video
 *  video  – 4K/1080p, 30/60 fps, HDR (HLG 10-bit), standard or cinematic stabilization
 *  action – 1080p60 with maximum stabilization
 *  slowmo – high-speed capture saved as ready-to-play slow motion
 *  dual   – front + back recorded together, picture-in-picture
 */
@SuppressLint("ViewConstructor")
class ICameraView(context: Context, appContext: AppContext) : ExpoView(context, appContext) {
  override val shouldUseAndroidLayout = true

  private val onReady by EventDispatcher()
  private val onError by EventDispatcher()
  private val onRecordingFinished by EventDispatcher()
  private val onPhotosCaptured by EventDispatcher()

  private val previewView = PreviewView(context).apply {
    implementationMode = PreviewView.ImplementationMode.COMPATIBLE
    scaleType = PreviewView.ScaleType.FILL_CENTER
    layoutParams = ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
  }
  private val executor = ContextCompat.getMainExecutor(context)

  private var provider: ProcessCameraProvider? = null
  private var extensions: ExtensionsManager? = null
  private var camera: Camera? = null
  private var imageCapture: ImageCapture? = null
  private var videoCapture: VideoCapture<Recorder>? = null
  private var recording: Recording? = null
  private var slowFps = 0
  private var usingNightExtension = false

  // Props
  private var mode = "photo"
  private var facing = "back"
  private var dualPrimary = "back"
  private var zoom = 1f
  private var ev = 0.0
  private var iso = 0
  private var shutterNs = 0L
  private var wb = "auto"
  private var kelvin = 5500
  private var focus = -1f
  private var flash = "off"
  private var torch = false
  private var mirror = true
  private var audio = true
  private var active = true
  private var videoQuality = "uhd"
  private var fps = 30
  private var hdrVideo = false
  private var stabilization = "cinematic"
  private var nightExtension = true

  private var rebindQueued = false
  private var burstEvOffset = 0.0

  init {
    addView(previewView)
  }

  /* ---------------- props ---------------- */

  private fun <T> rebindOnChange(old: T, new: T, set: (T) -> Unit) {
    if (old != new) { set(new); scheduleRebind() }
  }

  fun setMode(v: String) = rebindOnChange(mode, v) { mode = it }
  fun setFacing(v: String) = rebindOnChange(facing, v) { facing = it }
  fun setDualPrimary(v: String) = rebindOnChange(dualPrimary, v) { dualPrimary = it }
  fun setMirror(v: Boolean) = rebindOnChange(mirror, v) { mirror = it }
  fun setActive(v: Boolean) = rebindOnChange(active, v) { active = it }
  fun setVideoQuality(v: String) = rebindOnChange(videoQuality, v) { videoQuality = it }
  fun setFps(v: Int) = rebindOnChange(fps, v) { fps = it }
  fun setHdrVideo(v: Boolean) = rebindOnChange(hdrVideo, v) { hdrVideo = it }
  fun setStabilization(v: String) = rebindOnChange(stabilization, v) { stabilization = it }
  fun setNightExtension(v: Boolean) = rebindOnChange(nightExtension, v) { nightExtension = it }
  fun setAudio(v: Boolean) { audio = v }
  fun setZoom(v: Float) { zoom = v; camera?.cameraControl?.setZoomRatio(v) }
  fun setEvBias(v: Double) { ev = v; applyControls() }
  fun setIso(v: Int) { iso = v; applyControls() }
  fun setShutterNs(v: Long) { shutterNs = v; applyControls() }
  fun setWhiteBalance(v: String) { wb = v; applyControls() }
  fun setKelvin(v: Int) { kelvin = v; applyControls() }
  fun setFocusDistance(v: Float) { focus = v; applyControls() }
  fun setFlash(v: String) { flash = v; imageCapture?.flashMode = flashMode() }
  fun setTorch(v: Boolean) {
    torch = v
    camera?.let { if (it.cameraInfo.hasFlashUnit()) it.cameraControl.enableTorch(v) }
  }

  private fun flashMode() = when (flash) {
    "on" -> ImageCapture.FLASH_MODE_ON
    "auto" -> ImageCapture.FLASH_MODE_AUTO
    else -> ImageCapture.FLASH_MODE_OFF
  }

  /* ---------------- lifecycle ---------------- */

  override fun onAttachedToWindow() {
    super.onAttachedToWindow()
    scheduleRebind(150)
  }

  override fun onDetachedFromWindow() {
    super.onDetachedFromWindow()
    recording?.stop()
    recording = null
    provider?.unbindAll()
    camera = null
  }

  private fun scheduleRebind(delayMs: Long = 0) {
    if (rebindQueued) return
    rebindQueued = true
    postDelayed({ rebindQueued = false; rebind() }, delayMs)
  }

  private fun withProvider(block: (ProcessCameraProvider) -> Unit) {
    provider?.let { return block(it) }
    val f = ProcessCameraProvider.getInstance(context)
    f.addListener({
      try {
        val p = f.get()
        provider = p
        val ef = ExtensionsManager.getInstanceAsync(context, p)
        ef.addListener({
          extensions = try { ef.get() } catch (e: Throwable) { null }
          block(p)
        }, executor)
      } catch (e: Throwable) {
        emitError("Camera unavailable: ${e.message}")
      }
    }, executor)
  }

  private fun rebind() {
    if (!isAttachedToWindow || recording != null) return
    val owner = appContext.currentActivity as? LifecycleOwner
    if (owner == null) { emitError("Camera needs an active screen"); return }
    withProvider { p ->
      try {
        p.unbindAll()
        camera = null; imageCapture = null; videoCapture = null
        usingNightExtension = false; slowFps = 0
        if (!active) return@withProvider
        when (mode) {
          "dual" -> bindDual(p, owner)
          "slowmo" -> bindSlowMo(p, owner)
          "video", "action" -> bindVideo(p, owner)
          "pro" -> bindPro(p, owner)
          else -> bindPhoto(p, owner)
        }
        camera?.cameraControl?.setZoomRatio(zoom)
        setTorch(torch)
        applyControls()
        val z = camera?.cameraInfo?.zoomState?.value
        onReady(
          mapOf(
            "mode" to mode,
            "slowMotionFps" to slowFps,
            "nightExtension" to usingNightExtension,
            "zoomMin" to (z?.minZoomRatio ?: 1f).toDouble(),
            "zoomMax" to (z?.maxZoomRatio ?: 1f).toDouble(),
            "hasFlash" to (camera?.cameraInfo?.hasFlashUnit() ?: false),
          ),
        )
      } catch (e: Throwable) {
        emitError(e.message ?: e.toString())
      }
    }
  }

  private fun selector(f: String) =
    if (f == "front") CameraSelector.DEFAULT_FRONT_CAMERA else CameraSelector.DEFAULT_BACK_CAMERA

  private fun newPreview(stabilized: Boolean = false): Preview {
    val b = Preview.Builder()
    if (stabilized) b.setPreviewStabilizationEnabled(true)
    return b.build().also { it.setSurfaceProvider(previewView.surfaceProvider) }
  }

  private fun newImageCapture(): ImageCapture =
    ImageCapture.Builder()
      .setCaptureMode(ImageCapture.CAPTURE_MODE_MINIMIZE_LATENCY)
      .setFlashMode(flashMode())
      .build()

  private fun bindPhoto(p: ProcessCameraProvider, owner: LifecycleOwner) {
    var sel = selector(facing)
    val ext = extensions
    if (mode == "night" && nightExtension && ext != null && ext.isExtensionAvailable(sel, ExtensionMode.NIGHT)) {
      sel = ext.getExtensionEnabledCameraSelector(sel, ExtensionMode.NIGHT)
      usingNightExtension = true
    }
    val ic = newImageCapture()
    camera = p.bindToLifecycle(owner, sel, newPreview(), ic)
    imageCapture = ic
  }

  private fun buildRecorder(quality: Quality, bitrate: Int): Recorder =
    Recorder.Builder()
      .setQualitySelector(
        QualitySelector.from(quality, FallbackStrategy.lowerQualityOrHigherThan(Quality.SD)),
      )
      .setTargetVideoEncodingBitRate(bitrate)
      .build()

  private fun bindVideo(p: ProcessCameraProvider, owner: LifecycleOwner) {
    val sel = selector(facing)
    val info = p.getCameraInfo(sel)
    val action = mode == "action"
    val uhd = !action && videoQuality == "uhd"
    val targetFps = if (action) 60 else fps
    val recorder = buildRecorder(if (uhd) Quality.UHD else Quality.FHD, if (uhd) 60_000_000 else 24_000_000)

    val previewStab = (action || stabilization == "cinematic") &&
      (try { Preview.getPreviewCapabilities(info).isStabilizationSupported } catch (e: Throwable) { false })
    val vb = VideoCapture.Builder(recorder)
      .setMirrorMode(if (mirror) MirrorMode.MIRROR_MODE_ON_FRONT_ONLY else MirrorMode.MIRROR_MODE_OFF)
    if (!previewStab && stabilization != "off") vb.setVideoStabilizationEnabled(true)

    val ranges = info.supportedFrameRateRanges
    ranges.firstOrNull { it.lower == targetFps && it.upper == targetFps }
      ?.let { vb.setTargetFrameRate(it) }
      ?: ranges.filter { it.upper >= targetFps }.minByOrNull { it.upper }?.let { vb.setTargetFrameRate(Range(it.upper, it.upper)) }

    if (hdrVideo && !action) {
      val supported = Recorder.getVideoCapabilities(info).supportedDynamicRanges
      if (supported.contains(DynamicRange.HLG_10_BIT)) vb.setDynamicRange(DynamicRange.HLG_10_BIT)
      else if (supported.contains(DynamicRange.HDR_UNSPECIFIED_10_BIT)) vb.setDynamicRange(DynamicRange.HDR_UNSPECIFIED_10_BIT)
    }
    val vc = vb.build()
    camera = try {
      p.bindToLifecycle(owner, sel, newPreview(previewStab), vc)
    } catch (e: Throwable) {
      // Fall back to a plain configuration the device is guaranteed to support
      p.unbindAll()
      val plain = VideoCapture.withOutput(buildRecorder(Quality.FHD, 20_000_000))
      p.bindToLifecycle(owner, sel, newPreview(), plain).also { videoCapture = plain }
    }
    if (videoCapture == null) videoCapture = vc
  }

  private fun bindPro(p: ProcessCameraProvider, owner: LifecycleOwner) {
    val sel = selector(facing)
    val ic = ImageCapture.Builder()
      .setCaptureMode(ImageCapture.CAPTURE_MODE_MAXIMIZE_QUALITY)
      .setFlashMode(flashMode())
      .build()
    val vc = VideoCapture.Builder(buildRecorder(Quality.UHD, 60_000_000))
      .setMirrorMode(if (mirror) MirrorMode.MIRROR_MODE_ON_FRONT_ONLY else MirrorMode.MIRROR_MODE_OFF)
      .build()
    camera = try {
      p.bindToLifecycle(owner, sel, newPreview(), ic, vc).also { videoCapture = vc }
    } catch (e: Throwable) {
      p.unbindAll()
      p.bindToLifecycle(owner, sel, newPreview(), ic)
    }
    imageCapture = ic
  }

  @OptIn(ExperimentalHighSpeedVideo::class)
  @androidx.annotation.OptIn(markerClass = [ExperimentalHighSpeedVideo::class])
  private fun bindSlowMo(p: ProcessCameraProvider, owner: LifecycleOwner) {
    val sel = selector(facing)
    val info = p.getCameraInfo(sel)
    if (Recorder.getHighSpeedVideoCapabilities(info) == null) {
      throw IllegalStateException("Slow motion isn't supported by this camera")
    }
    val vc = VideoCapture.withOutput(Recorder.Builder().build())
    val builder = HighSpeedVideoSessionConfig.Builder(vc)
    builder.setPreview(newPreview())
    builder.setSlowMotionEnabled(true)
    val best = info.getSupportedFrameRateRanges(builder.build()).maxByOrNull { it.upper }
    if (best != null) builder.setFrameRateRange(best)
    slowFps = best?.upper ?: 0
    camera = p.bindToLifecycle(owner, sel, builder.build())
    videoCapture = vc
  }

  private fun bindDual(p: ProcessCameraProvider, owner: LifecycleOwner) {
    val pair = p.availableConcurrentCameraInfos.firstOrNull { list ->
      list.any { it.lensFacing == CameraSelector.LENS_FACING_BACK } &&
        list.any { it.lensFacing == CameraSelector.LENS_FACING_FRONT }
    } ?: throw IllegalStateException("This phone can't run front and back cameras at the same time")

    val back = pair.first { it.lensFacing == CameraSelector.LENS_FACING_BACK }
    val front = pair.first { it.lensFacing == CameraSelector.LENS_FACING_FRONT }
    val main = if (dualPrimary == "front") front else back
    val pip = if (dualPrimary == "front") back else front

    val vc = VideoCapture.withOutput(buildRecorder(Quality.FHD, 20_000_000))
    val group = UseCaseGroup.Builder().addUseCase(newPreview()).addUseCase(vc).build()
    val primary = ConcurrentCamera.SingleCameraConfig(
      main.cameraSelector,
      group,
      CompositionSettings.Builder().setAlpha(1f).setOffset(0f, 0f).setScale(1f, 1f).build(),
      owner,
    )
    val secondary = ConcurrentCamera.SingleCameraConfig(
      pip.cameraSelector,
      group,
      CompositionSettings.Builder()
        .setAlpha(1f)
        .setOffset(2 / 3f - 0.1f, 2 / 3f - 0.1f)
        .setScale(1 / 3f, 1 / 3f)
        .build(),
      owner,
    )
    camera = p.bindToLifecycle(listOf(primary, secondary)).cameras.firstOrNull()
    videoCapture = vc
  }

  /* ---------------- manual controls ---------------- */

  @OptIn(ExperimentalCamera2Interop::class)
  @androidx.annotation.OptIn(markerClass = [ExperimentalCamera2Interop::class])
  private fun applyControls() {
    val cam = camera ?: return
    try {
      // Camera2 overrides only in Pro; other modes stay fully automatic so the vendor 3A runs normally
      if (mode == "pro") {
        val b = CaptureRequestOptions.Builder()
        val manualExposure = iso > 0 && shutterNs > 0
        if (manualExposure) {
          b.setCaptureRequestOption(CaptureRequest.CONTROL_AE_MODE, CaptureRequest.CONTROL_AE_MODE_OFF)
          b.setCaptureRequestOption(CaptureRequest.SENSOR_SENSITIVITY, iso)
          b.setCaptureRequestOption(CaptureRequest.SENSOR_EXPOSURE_TIME, shutterNs)
          b.setCaptureRequestOption(CaptureRequest.SENSOR_FRAME_DURATION, max(shutterNs, 33_333_333L))
        }
        if (wb == "kelvin") {
          b.setCaptureRequestOption(CaptureRequest.CONTROL_AWB_MODE, CaptureRequest.CONTROL_AWB_MODE_OFF)
          b.setCaptureRequestOption(CaptureRequest.COLOR_CORRECTION_MODE, CaptureRequest.COLOR_CORRECTION_MODE_TRANSFORM_MATRIX)
          b.setCaptureRequestOption(CaptureRequest.COLOR_CORRECTION_GAINS, kelvinToGains(kelvin))
        } else if (wb != "auto") {
          b.setCaptureRequestOption(
            CaptureRequest.CONTROL_AWB_MODE,
            when (wb) {
              "daylight" -> CaptureRequest.CONTROL_AWB_MODE_DAYLIGHT
              "cloudy" -> CaptureRequest.CONTROL_AWB_MODE_CLOUDY_DAYLIGHT
              "shade" -> CaptureRequest.CONTROL_AWB_MODE_SHADE
              "tungsten" -> CaptureRequest.CONTROL_AWB_MODE_INCANDESCENT
              "fluorescent" -> CaptureRequest.CONTROL_AWB_MODE_FLUORESCENT
              "twilight" -> CaptureRequest.CONTROL_AWB_MODE_TWILIGHT
              else -> CaptureRequest.CONTROL_AWB_MODE_AUTO
            },
          )
        }
        if (focus >= 0f) {
          b.setCaptureRequestOption(CaptureRequest.CONTROL_AF_MODE, CaptureRequest.CONTROL_AF_MODE_OFF)
          b.setCaptureRequestOption(CaptureRequest.LENS_FOCUS_DISTANCE, focus)
        }
        Camera2CameraControl.from(cam.cameraControl).setCaptureRequestOptions(b.build())
        if (manualExposure) return
      } else if (!usingNightExtension) {
        Camera2CameraControl.from(cam.cameraControl).clearCaptureRequestOptions()
      }
      setEvIndex(ev + burstEvOffset)
    } catch (e: Throwable) {
      emitError("Camera control rejected: ${e.message}")
    }
  }

  private fun setEvIndex(target: Double) {
    val cam = camera ?: return
    val state = cam.cameraInfo.exposureState
    if (!state.isExposureCompensationSupported) return
    val step = state.exposureCompensationStep.toDouble()
    if (step <= 0) return
    val idx = (target / step).roundToInt()
      .coerceIn(state.exposureCompensationRange.lower, state.exposureCompensationRange.upper)
    cam.cameraControl.setExposureCompensationIndex(idx)
  }

  /** Colour temperature → RGGB gains (Tanner Helland's blackbody fit, scaled to typical sensor gains). */
  private fun kelvinToGains(k: Int): RggbChannelVector {
    val t = k.coerceIn(2000, 10000) / 100.0
    val r = if (t <= 66) 255.0 else 329.698727446 * (t - 60).pow(-0.1332047592)
    val g = if (t <= 66) 99.4708025861 * ln(t) - 161.1195681661 else 288.1221695283 * (t - 60).pow(-0.0755148492)
    val bl = when {
      t >= 66 -> 255.0
      t <= 19 -> 1.0
      else -> 138.5177312231 * ln(t - 10) - 305.0447927307
    }
    val rr = r.coerceIn(1.0, 255.0)
    val gg = g.coerceIn(1.0, 255.0)
    val bb = bl.coerceIn(1.0, 255.0)
    return RggbChannelVector(
      (2.0 * gg / rr).toFloat().coerceIn(0.5f, 6f),
      1f,
      1f,
      (1.6 * gg / bb).toFloat().coerceIn(0.5f, 6f),
    )
  }

  fun focusAt(xDp: Float, yDp: Float) {
    val cam = camera ?: return
    val d = resources.displayMetrics.density
    val point = previewView.meteringPointFactory.createPoint(xDp * d, yDp * d)
    try {
      cam.cameraControl.startFocusAndMetering(FocusMeteringAction.Builder(point).build())
    } catch (_: Throwable) {}
  }

  /* ---------------- capture ---------------- */

  /**
   * Captures [count] frames back to back. A non-zero [evShift] temporarily biases exposure first
   * (HDR+ shoots under-exposed bursts). Emits onPhotosCaptured with every saved path.
   */
  fun captureBurst(count: Int, evShift: Double) {
    val ic = imageCapture ?: run { emitError("Photos aren't available in this mode"); return }
    val n = count.coerceIn(1, 8)
    val paths = ArrayList<String>()
    val firstFlash = ic.flashMode

    fun finish(error: String?) {
      burstEvOffset = 0.0
      ic.flashMode = firstFlash
      applyControls()
      onPhotosCaptured(mapOf("paths" to paths, "error" to error, "nightExtension" to usingNightExtension))
    }

    fun shoot(i: Int) {
      val file = File(context.cacheDir, "iCam_${System.currentTimeMillis()}_$i.jpg")
      val meta = ImageCapture.Metadata().apply { isReversedHorizontal = facing == "front" && mirror }
      if (i > 0) ic.flashMode = ImageCapture.FLASH_MODE_OFF
      ic.takePicture(
        ImageCapture.OutputFileOptions.Builder(file).setMetadata(meta).build(),
        executor,
        object : ImageCapture.OnImageSavedCallback {
          override fun onImageSaved(output: ImageCapture.OutputFileResults) {
            paths.add(file.absolutePath)
            if (i + 1 < n) shoot(i + 1) else finish(null)
          }

          override fun onError(exception: ImageCaptureException) {
            finish(exception.message ?: "Capture failed")
          }
        },
      )
    }

    if (n > 1 && evShift != 0.0 && !usingNightExtension && mode != "pro") {
      burstEvOffset = evShift
      applyControls()
      postDelayed({ shoot(0) }, 320)
    } else {
      shoot(0)
    }
  }

  @SuppressLint("MissingPermission")
  fun startRecording() {
    val vc = videoCapture ?: run { emitError("Video isn't available in this mode"); return }
    if (recording != null) return
    val file = File(context.cacheDir, "iCam_${mode}_${System.currentTimeMillis()}.mp4")
    var pending = vc.output.prepareRecording(context, FileOutputOptions.Builder(file).build())
    val micGranted = ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) ==
      PackageManager.PERMISSION_GRANTED
    if (audio && micGranted && mode != "slowmo") pending = pending.withAudioEnabled()
    recording = pending.start(executor) { event ->
      if (event is VideoRecordEvent.Finalize) {
        recording = null
        val ok = file.exists() && file.length() > 0
        onRecordingFinished(
          mapOf(
            "path" to if (ok) file.absolutePath else null,
            "durationMs" to event.recordingStats.recordedDurationNanos / 1_000_000.0,
            "slowMotion" to (mode == "slowmo"),
            "error" to if (event.hasError()) "Recorder error ${event.error}" else null,
          ),
        )
      }
    }
  }

  fun stopRecording() {
    recording?.stop()
  }

  private fun emitError(message: String) {
    onError(mapOf("message" to message))
  }
}
