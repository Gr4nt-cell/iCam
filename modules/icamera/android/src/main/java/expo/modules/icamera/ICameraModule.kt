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
    AsyncFunction("getCapabilities") {
      val ctx = appContext.reactContext ?: throw IllegalStateException("No context")
      val provider = ProcessCameraProvider.getInstance(ctx).get(10, TimeUnit.SECONDS)
      val extensions = try {
        ExtensionsManager.getInstanceAsync(ctx, provider).get(10, TimeUnit.SECONDS)
      } catch (e: Throwable) { null }
      capabilities(ctx, provider, extensions)
    }

    View(ICameraView::class) {
      Events("onReady", "onError", "onRecordingFinished", "onPhotosCaptured")

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

      AsyncFunction("capture") { view: ICameraView, count: Int, evShift: Double ->
        view.captureBurst(count, evShift)
      }.runOnQueue(expo.modules.kotlin.functions.Queues.MAIN)
      AsyncFunction("startRecording") { view: ICameraView -> view.startRecording() }
        .runOnQueue(expo.modules.kotlin.functions.Queues.MAIN)
      AsyncFunction("stopRecording") { view: ICameraView -> view.stopRecording() }
        .runOnQueue(expo.modules.kotlin.functions.Queues.MAIN)
      AsyncFunction("focus") { view: ICameraView, x: Double, y: Double -> view.focusAt(x.toFloat(), y.toFloat()) }
        .runOnQueue(expo.modules.kotlin.functions.Queues.MAIN)
    }
  }

  @OptIn(ExperimentalCamera2Interop::class, ExperimentalHighSpeedVideo::class)
  @androidx.annotation.OptIn(markerClass = [ExperimentalCamera2Interop::class, ExperimentalHighSpeedVideo::class])
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
    )
  }

  @OptIn(ExperimentalCamera2Interop::class, ExperimentalHighSpeedVideo::class)
  @androidx.annotation.OptIn(markerClass = [ExperimentalCamera2Interop::class, ExperimentalHighSpeedVideo::class])
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

  private fun qualityName(q: Quality) = when (q) {
    Quality.UHD -> "4K"
    Quality.FHD -> "1080p"
    Quality.HD -> "720p"
    Quality.SD -> "480p"
    else -> q.toString()
  }
}
