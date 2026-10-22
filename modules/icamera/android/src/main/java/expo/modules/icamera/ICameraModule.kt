package expo.modules.icamera

import android.content.Context
import android.content.pm.PackageManager
import android.hardware.camera2.CameraCharacteristics
import android.hardware.camera2.CameraMetadata
import android.util.Size
import androidx.camera.camera2.interop.Camera2CameraInfo
import androidx.camera.camera2.interop.ExperimentalCamera2Interop
import androidx.camera.core.CameraInfo
import androidx.camera.core.CameraSelector
import androidx.camera.core.DynamicRange
import androidx.camera.core.Preview
import androidx.camera.extensions.ExtensionMode
import androidx.camera.extensions.ExtensionsManager
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.video.ExperimentalHighSpeedVideo
import androidx.camera.video.Quality
import androidx.camera.video.Recorder
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.util.concurrent.TimeUnit

class ICameraModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("ICamera")

    // Record any uncaught Java/Kotlin crash so the next launch can show it on screen
    OnCreate {
      // Start the subject-segmentation model download early (Portrait mode)
      Thread { PersonSegmenter.warmUp() }.start()
      val ctx = appContext.reactContext?.applicationContext ?: return@OnCreate
      val crashFile = java.io.File(ctx.filesDir, "last_crash.txt")
      val previous = Thread.getDefaultUncaughtExceptionHandler()
      Thread.setDefaultUncaughtExceptionHandler { thread, error ->
        try {
          val sw = java.io.StringWriter()
          error.printStackTrace(java.io.PrintWriter(sw))
          crashFile.writeText(
            "Thread: ${thread.name}\nDevice: ${android.os.Build.MANUFACTURER} ${android.os.Build.MODEL} " +
              "(Android ${android.os.Build.VERSION.RELEASE}, SDK ${android.os.Build.VERSION.SDK_INT})\n\n" +
              sw.toString().take(12000),
          )
        } catch (_: Throwable) {}
        previous?.uncaughtException(thread, error)
      }
    }

    /** Finds faces in a photo (upright, normalized 0..1 boxes) for face-priority exposure. */
    AsyncFunction("detectFaces") { path: String -> FaceFinder.find(path) }

    /**
     * Opens a saved photo/video (MediaStore id) in another app.
     * chooser = false → the system default gallery (Android offers "Always" the first time);
     * chooser = true  → the "Open with" picker every time.
     */
    AsyncFunction("openMedia") { id: String, isVideo: Boolean, chooser: Boolean ->
      val activity = appContext.currentActivity ?: throw IllegalStateException("No activity")
      val base = if (isVideo) android.provider.MediaStore.Video.Media.EXTERNAL_CONTENT_URI
        else android.provider.MediaStore.Images.Media.EXTERNAL_CONTENT_URI
      val uri = android.content.ContentUris.withAppendedId(base, id.toLong())
      val view = android.content.Intent(android.content.Intent.ACTION_VIEW).apply {
        setDataAndType(uri, if (isVideo) "video/*" else "image/*")
        addFlags(android.content.Intent.FLAG_GRANT_READ_URI_PERMISSION)
      }
      val intent = if (chooser) android.content.Intent.createChooser(view, "Open with") else view
      activity.startActivity(intent)
    }.runOnQueue(expo.modules.kotlin.functions.Queues.MAIN)

    /** Person mask for Portrait mode (grayscale PNG, upright, 1 = person). */
    AsyncFunction("segmentPerson") { path: String ->
      val ctx = appContext.reactContext ?: throw IllegalStateException("No context")
      PersonSegmenter.segment(ctx, path)
    }

    /** Returns (and clears) the crash recorded on the previous run, if any. */
    Function("takeLastCrash") {
      val ctx = appContext.reactContext?.applicationContext ?: return@Function null
      val f = java.io.File(ctx.filesDir, "last_crash.txt")
      if (!f.exists()) return@Function null
      val text = f.readText()
      f.delete()
      text
    }

    /** Everything the app needs to know about this phone's cameras, read once at startup. */
    /** On-device AI 4× super-resolution (null when the model isn't in this build). */
    AsyncFunction("aiUpscale") { inPath: String, maxEdge: Int ->
      val ctx = appContext.reactContext ?: throw IllegalStateException("No context")
      if (!AiUpscaler.available(ctx)) return@AsyncFunction null
      val out = java.io.File(ctx.cacheDir, "iCam_ai_${System.currentTimeMillis()}.jpg").absolutePath
      AiUpscaler.upscale(ctx, inPath, out, maxEdge.coerceIn(64, 1024))
    }

    Function("aiAvailable") {
      val ctx = appContext.reactContext ?: return@Function false
      AiUpscaler.available(ctx)
    }

    AsyncFunction("getCapabilities") {
      val ctx = appContext.reactContext ?: throw IllegalStateException("No context")
      val provider = ProcessCameraProvider.getInstance(ctx).get(10, TimeUnit.SECONDS)
      val extensions = try {
        ExtensionsManager.getInstanceAsync(ctx, provider).get(10, TimeUnit.SECONDS)
      } catch (e: Throwable) { null }
      capabilities(ctx, provider, extensions)
    }

    View(ICameraView::class) {
      Events("onReady", "onError", "onRecordingFinished", "onPhotosCaptured", "onDualChange", "onPortraitStatus", "onRecordingState", "onGesture", "onRearScreen")

      Prop("mode") { view: ICameraView, v: String -> view.setMode(v) }
      Prop("facing") { view: ICameraView, v: String -> view.setFacing(v) }
      Prop("dualPrimary") { view: ICameraView, v: String -> view.setDualPrimary(v) }
      Prop("zoom") { view: ICameraView, v: Double -> view.setZoom(v.toFloat()) }
      Prop("evBias") { view: ICameraView, v: Double -> view.setEvBias(v) }
      Prop("iso") { view: ICameraView, v: Double -> view.setIso(v.toInt()) }
      Prop("shutterNs") { view: ICameraView, v: Double -> view.setShutterNs(v.toLong()) }
      Prop("whiteBalance") { view: ICameraView, v: String -> view.setWhiteBalance(v) }
      Prop("kelvin") { view: ICameraView, v: Double -> view.setKelvin(v.toInt()) }
      Prop("focusDistance") { view: ICameraView, v: Double -> view.setFocusDistance(v.toFloat()) }
      Prop("flash") { view: ICameraView, v: String -> view.setFlash(v) }
      Prop("torch") { view: ICameraView, v: Boolean -> view.setTorch(v) }
      Prop("mirror") { view: ICameraView, v: Boolean -> view.setMirror(v) }
      Prop("audio") { view: ICameraView, v: Boolean -> view.setAudio(v) }
      Prop("active") { view: ICameraView, v: Boolean -> view.setActive(v) }
      Prop("videoQuality") { view: ICameraView, v: String -> view.setVideoQuality(v) }
      Prop("fps") { view: ICameraView, v: Double -> view.setFps(v.toInt()) }
      Prop("hdrVideo") { view: ICameraView, v: Boolean -> view.setHdrVideo(v) }
      Prop("stabilization") { view: ICameraView, v: String -> view.setStabilization(v) }
      Prop("nightExtension") { view: ICameraView, v: Boolean -> view.setNightExtension(v) }
      Prop("aspect") { view: ICameraView, v: String -> view.setAspect(v) }
      Prop("bokeh") { view: ICameraView, v: Double -> view.setBokeh(v.toFloat()) }
      Prop("palmShutter") { view: ICameraView, v: Boolean -> view.setPalmShutter(v) }
      Prop("voiceShutter") { view: ICameraView, v: Boolean -> view.setVoiceShutter(v) }
      Prop("rearScreen") { view: ICameraView, v: Boolean -> view.setRearScreen(v) }
      Prop("rearState") { view: ICameraView, v: Map<String, Any?> -> view.setRearState(v) }
      Prop("faceSmoothing") { view: ICameraView, v: Double -> view.setFaceSmoothing(v.toFloat()) }
      Prop("filterParams") { view: ICameraView, v: List<Double> -> view.setFilterParams(v.map { it.toFloat() }.toFloatArray()) }
      Prop("previewFit") { view: ICameraView, v: Boolean -> view.setPreviewFit(v) }
      Prop("dualPip") { view: ICameraView, v: Map<String, Any?> ->
        view.setDualPip(
          (v["x"] as? Number)?.toFloat() ?: 0.78f,
          (v["y"] as? Number)?.toFloat() ?: 0.2f,
          (v["size"] as? Number)?.toFloat() ?: 0.34f,
        )
      }

      AsyncFunction("capture") { view: ICameraView, count: Int, evShift: Double, shortEv: Double ->
        view.captureBurst(count, evShift, shortEv)
      }.runOnQueue(expo.modules.kotlin.functions.Queues.MAIN)
      AsyncFunction("movePip") { view: ICameraView, x: Double, y: Double ->
        view.movePip(x.toFloat(), y.toFloat())
      }.runOnQueue(expo.modules.kotlin.functions.Queues.MAIN)
      AsyncFunction("startRecording") { view: ICameraView -> view.startRecording() }
        .runOnQueue(expo.modules.kotlin.functions.Queues.MAIN)
      AsyncFunction("stopRecording") { view: ICameraView -> view.stopRecording() }
        .runOnQueue(expo.modules.kotlin.functions.Queues.MAIN)
      AsyncFunction("pauseRecording") { view: ICameraView -> view.pauseRecording() }
        .runOnQueue(expo.modules.kotlin.functions.Queues.MAIN)
      AsyncFunction("resumeRecording") { view: ICameraView -> view.resumeRecording() }
        .runOnQueue(expo.modules.kotlin.functions.Queues.MAIN)
      AsyncFunction("focus") { view: ICameraView, x: Double, y: Double -> view.focusAt(x.toFloat(), y.toFloat()) }
        .runOnQueue(expo.modules.kotlin.functions.Queues.MAIN)
    }
  }

  @OptIn(ExperimentalCamera2Interop::class, ExperimentalHighSpeedVideo::class, androidx.camera.core.ExperimentalSessionConfig::class)
  @androidx.annotation.OptIn(markerClass = [ExperimentalCamera2Interop::class, ExperimentalHighSpeedVideo::class, androidx.camera.core.ExperimentalSessionConfig::class])
  private fun capabilities(ctx: Context, provider: ProcessCameraProvider, ext: ExtensionsManager?): Map<String, Any?> {
    val pm = ctx.packageManager
    val concurrent = try {
      pm.hasSystemFeature(PackageManager.FEATURE_CAMERA_CONCURRENT) &&
        provider.availableConcurrentCameraInfos.any { pair ->
          pair.any { it.lensFacing == CameraSelector.LENS_FACING_BACK } &&
            pair.any { it.lensFacing == CameraSelector.LENS_FACING_FRONT }
        }
    } catch (e: Throwable) { false }

    val cameras = provider.availableCameraInfos.mapNotNull { info ->
      try { describe(info, ext) } catch (e: Throwable) { null }
    }
    val back = cameras.firstOrNull { it["position"] == "back" } ?: cameras.firstOrNull()

    return mapOf(
      "concurrent" to concurrent,
      "slowMotion" to (back?.get("slowMotion") == true),
      "manualSensor" to (back?.get("manualSensor") == true),
      "manualWhiteBalance" to (back?.get("manualWhiteBalance") == true),
      "nightExtension" to (back?.get("nightExtension") == true),
      "isoMin" to (back?.get("isoMin") ?: 0),
      "isoMax" to (back?.get("isoMax") ?: 0),
      "exposureMinNs" to (back?.get("exposureMinNs") ?: 0.0),
      "exposureMaxNs" to (back?.get("exposureMaxNs") ?: 0.0),
      "minFocusDistance" to (back?.get("minFocusDistance") ?: 0.0),
      "cameras" to cameras,
      "portraitVideo" to portraitVideoCapable(ctx),
    ) + zoomProfile(ctx, back) + macroProfile(ctx) + mapOf(
      "rearScreen" to (RearScreen.visibleRearDisplay(ctx) != null),
      "root" to RearScreen.hasRoot(),
    )
  }

  @OptIn(ExperimentalCamera2Interop::class, ExperimentalHighSpeedVideo::class, androidx.camera.core.ExperimentalSessionConfig::class)
  @androidx.annotation.OptIn(markerClass = [ExperimentalCamera2Interop::class, ExperimentalHighSpeedVideo::class, androidx.camera.core.ExperimentalSessionConfig::class])
  private fun describe(info: CameraInfo, ext: ExtensionsManager?): Map<String, Any?> {
    val c2 = Camera2CameraInfo.from(info)
    fun <T> ch(key: CameraCharacteristics.Key<T>): T? = try { c2.getCameraCharacteristic(key) } catch (e: Throwable) { null }

    val caps = ch(CameraCharacteristics.REQUEST_AVAILABLE_CAPABILITIES) ?: IntArray(0)
    val position = when (info.lensFacing) {
      CameraSelector.LENS_FACING_BACK -> "back"
      CameraSelector.LENS_FACING_FRONT -> "front"
      else -> "external"
    }
    val level = when (ch(CameraCharacteristics.INFO_SUPPORTED_HARDWARE_LEVEL)) {
      CameraMetadata.INFO_SUPPORTED_HARDWARE_LEVEL_LEGACY -> "legacy"
      CameraMetadata.INFO_SUPPORTED_HARDWARE_LEVEL_LIMITED -> "limited"
      CameraMetadata.INFO_SUPPORTED_HARDWARE_LEVEL_FULL -> "full"
      CameraMetadata.INFO_SUPPORTED_HARDWARE_LEVEL_3 -> "level-3"
      else -> "external"
    }
    val jpeg: Array<Size> = ch(CameraCharacteristics.SCALER_STREAM_CONFIGURATION_MAP)
      ?.getOutputSizes(android.graphics.ImageFormat.JPEG) ?: emptyArray()
    val maxPx = jpeg.maxOfOrNull { it.width.toLong() * it.height } ?: 0L
    val focal = ch(CameraCharacteristics.LENS_INFO_AVAILABLE_FOCAL_LENGTHS)?.toList() ?: emptyList()
    val physical = try { c2.cameraCharacteristicsMap.size } catch (e: Throwable) { 1 }

    val videoCaps = Recorder.getVideoCapabilities(info)
    val qualities = videoCaps.getSupportedQualities(DynamicRange.SDR).map { qualityName(it) }
    val hdr = videoCaps.supportedDynamicRanges.any { it != DynamicRange.SDR }
    val fps = info.supportedFrameRateRanges.maxOfOrNull { it.upper } ?: 30
    val zoom = info.zoomState.value
    val exp = info.exposureState
    val stab = try { Preview.getPreviewCapabilities(info).isStabilizationSupported } catch (e: Throwable) { false }
    val videoStab = try { videoCaps.isStabilizationSupported } catch (e: Throwable) { false }
    val slowMo = try { Recorder.getHighSpeedVideoCapabilities(info) != null } catch (e: Throwable) { false }
    val night = try { ext?.isExtensionAvailable(info.cameraSelector, ExtensionMode.NIGHT) == true } catch (e: Throwable) { false }
    val iso = ch(CameraCharacteristics.SENSOR_INFO_SENSITIVITY_RANGE)
    val expRange = ch(CameraCharacteristics.SENSOR_INFO_EXPOSURE_TIME_RANGE)

    return mapOf(
      "id" to c2.cameraId,
      "position" to position,
      "hardwareLevel" to level,
      "physicalCameras" to physical,
      "focalLengths" to focal.map { it.toDouble() },
      "maxPhotoMp" to (maxPx / 100_000L) / 10.0,
      "videoQualities" to qualities,
      "videoHdr" to hdr,
      "maxFps" to fps,
      "zoomMin" to (zoom?.minZoomRatio ?: 1f).toDouble(),
      "zoomMax" to (zoom?.maxZoomRatio ?: 1f).toDouble(),
      "evMin" to exp.exposureCompensationRange.lower * exp.exposureCompensationStep.toDouble(),
      "evMax" to exp.exposureCompensationRange.upper * exp.exposureCompensationStep.toDouble(),
      "flash" to info.hasFlashUnit(),
      "previewStabilization" to stab,
      "videoStabilization" to videoStab,
      "slowMotion" to slowMo,
      "nightExtension" to night,
      "manualSensor" to caps.contains(CameraMetadata.REQUEST_AVAILABLE_CAPABILITIES_MANUAL_SENSOR),
      "manualWhiteBalance" to caps.contains(CameraMetadata.REQUEST_AVAILABLE_CAPABILITIES_MANUAL_POST_PROCESSING),
      "raw" to caps.contains(CameraMetadata.REQUEST_AVAILABLE_CAPABILITIES_RAW),
      "isoMin" to (iso?.lower ?: 0),
      "isoMax" to (iso?.upper ?: 0),
      "exposureMinNs" to (expRange?.lower ?: 0L).toDouble(),
      "exposureMaxNs" to (expRange?.upper ?: 0L).toDouble(),
      "minFocusDistance" to (ch(CameraCharacteristics.LENS_INFO_MINIMUM_FOCUS_DISTANCE) ?: 0f).toDouble(),
      "sensorOrientation" to (ch(CameraCharacteristics.SENSOR_ORIENTATION) ?: 0),
    )
  }

  /**
   * Telephoto detection from lens data: 35 mm-equivalent focal length of every rear camera
   * (including the physical lenses behind a logical multi-camera). Max zoom scales with the
   * telephoto's optical reach (e.g. 3× → 60×, 5× → 100×); phones without one stay at 2×.
   */
  private fun zoomProfile(ctx: Context, back: Map<String, Any?>?): Map<String, Any?> {
    val hwMax = (back?.get("zoomMax") as? Double) ?: 1.0
    return try {
      val cm = ctx.getSystemService(Context.CAMERA_SERVICE) as android.hardware.camera2.CameraManager
      fun eq(id: String): Double? {
        val c = cm.getCameraCharacteristics(id)
        if (c.get(CameraCharacteristics.LENS_FACING) != CameraMetadata.LENS_FACING_BACK) return null
        val f = c.get(CameraCharacteristics.LENS_INFO_AVAILABLE_FOCAL_LENGTHS)?.minOrNull() ?: return null
        val sz = c.get(CameraCharacteristics.SENSOR_INFO_PHYSICAL_SIZE) ?: return null
        val diag = Math.hypot(sz.width.toDouble(), sz.height.toDouble())
        return if (diag > 0) f * 43.27 / diag else null
      }
      val ids = cm.cameraIdList.toList()
      val mainId = ids.firstOrNull { cm.getCameraCharacteristics(it).get(CameraCharacteristics.LENS_FACING) == CameraMetadata.LENS_FACING_BACK }
      val main = mainId?.let { eq(it) }
      val all = HashSet<String>(ids)
      if (android.os.Build.VERSION.SDK_INT >= 28) ids.forEach { id ->
        try { all.addAll(cm.getCameraCharacteristics(id).physicalCameraIds) } catch (_: Throwable) {}
      }
      val focals = all.mapNotNull { try { eq(it) } catch (_: Throwable) { null } }
      // Main lens = the one closest to the default rear camera's focal length (26 mm-ish)
      val mainEq = main ?: focals.minByOrNull { Math.abs(it - 26) }
      val tele = focals.maxOrNull()
      val ratio = if (mainEq != null && tele != null && mainEq > 0) tele / mainEq else 1.0
      val telephoto = ratio >= 1.8
      val maxZoom = if (telephoto) (ratio * 20).coerceIn(10.0, 100.0) else minOf(2.0, maxOf(hwMax, 2.0))
      mapOf(
        "telephoto" to telephoto,
        "telephotoRatio" to Math.round(ratio * 10) / 10.0,
        "maxZoom" to Math.round(maxZoom).toDouble(),
        "mainFocalEq" to (mainEq ?: 0.0),
      )
    } catch (e: Throwable) {
      mapOf("telephoto" to false, "telephotoRatio" to 1.0, "maxZoom" to 2.0, "mainFocalEq" to 0.0)
    }
  }

  private fun macroProfile(ctx: Context): Map<String, Any?> {
    val m = MacroFinder.find(ctx) ?: return mapOf("macro" to false)
    return mapOf("macro" to true, "macroKind" to m.kind, "macroMinFocusCm" to Math.round(m.minFocusCm * 10) / 10.0)
  }

  /** Hardware gate for live background blur: enough RAM, 64-bit, not a low-RAM device, 6+ cores. */
  private fun portraitVideoCapable(ctx: Context): Boolean = try {
    val am = ctx.getSystemService(Context.ACTIVITY_SERVICE) as android.app.ActivityManager
    val mi = android.app.ActivityManager.MemoryInfo().also { am.getMemoryInfo(it) }
    val gb = mi.totalMem / (1024.0 * 1024 * 1024)
    val is64 = android.os.Build.SUPPORTED_64_BIT_ABIS.isNotEmpty()
    val cores = Runtime.getRuntime().availableProcessors()
    val perfClass = if (android.os.Build.VERSION.SDK_INT >= 31) android.os.Build.VERSION.MEDIA_PERFORMANCE_CLASS else 0
    !am.isLowRamDevice && is64 && cores >= 6 && (gb >= 5.5 || (perfClass >= 31 && gb >= 3.5))
  } catch (e: Throwable) { true }

  private fun qualityName(q: Quality) = when (q) {
    Quality.UHD -> "4K"
    Quality.FHD -> "1080p"
    Quality.HD -> "720p"
    Quality.SD -> "480p"
    else -> q.toString()
  }
}
