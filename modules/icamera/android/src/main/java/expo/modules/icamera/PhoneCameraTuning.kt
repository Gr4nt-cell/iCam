package expo.modules.icamera

import android.hardware.camera2.CameraCharacteristics
import android.os.Build
import androidx.camera.camera2.interop.Camera2CameraInfo
import androidx.camera.camera2.interop.ExperimentalCamera2Interop
import androidx.camera.core.CameraInfo
import androidx.camera.core.CameraSelector
import androidx.camera.core.DynamicRange
import androidx.camera.video.Recorder

/** Only considers cameras CameraX exposes and can record from; never forces hidden physical IDs. */
@OptIn(ExperimentalCamera2Interop::class)
@androidx.annotation.OptIn(markerClass = [ExperimentalCamera2Interop::class])
internal object PhoneCameraTuning {
  fun frontSelector(hdr: Boolean): CameraSelector = CameraSelector.Builder()
    .requireLensFacing(CameraSelector.LENS_FACING_FRONT)
    .addCameraFilter { infos ->
      val candidates = infos.filter { info ->
        try {
          val caps = Recorder.getVideoCapabilities(info)
          val range = if (hdr) when {
            caps.supportedDynamicRanges.contains(DynamicRange.HLG_10_BIT) -> DynamicRange.HLG_10_BIT
            caps.supportedDynamicRanges.contains(DynamicRange.HDR10_10_BIT) -> DynamicRange.HDR10_10_BIT
            else -> null
          } else DynamicRange.SDR
          range != null && caps.getSupportedQualities(range).isNotEmpty()
        } catch (_: Exception) { false }
      }
      // A stable sort retains the phone's default camera if metadata cannot distinguish lenses.
      if (candidates.isEmpty()) infos else candidates.sortedByDescending { fieldOfViewScore(it) }
    }.build()

  private fun fieldOfViewScore(info: CameraInfo): Double = try {
    val c2 = Camera2CameraInfo.from(info)
    val size = c2.getCameraCharacteristic(CameraCharacteristics.SENSOR_INFO_PHYSICAL_SIZE)
    val focal = c2.getCameraCharacteristic(CameraCharacteristics.LENS_INFO_AVAILABLE_FOCAL_LENGTHS)?.minOrNull()
    val minimum = if (Build.VERSION.SDK_INT >= 30)
      c2.getCameraCharacteristic(CameraCharacteristics.CONTROL_ZOOM_RATIO_RANGE)?.lower ?: 1f else 1f
    if (size == null || focal == null) 0.0 else PhoneCameraPolicy.viewScore(size.width,size.height,focal,minimum)
  } catch (_: Exception) { 0.0 }
}
