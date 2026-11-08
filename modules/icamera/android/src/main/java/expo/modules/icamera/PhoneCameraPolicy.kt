package expo.modules.icamera

import kotlin.math.*

/** Hardware-relative framing; UI 1x means the widest zoom the selected selfie camera supports. */
internal object PhoneCameraPolicy {
  fun zoomBase(front: Boolean, minimum: Float): Float =
    if (front && minimum.isFinite() && minimum > 0f) minimum else 1f

  fun hardwareZoom(front: Boolean, uiZoom: Float, minimum: Float, maximum: Float): Float =
    (uiZoom * zoomBase(front,minimum)).coerceIn(minimum,maximum)

  fun digitalZoom(front: Boolean, uiZoom: Float, minimum: Float, maximum: Float): Float =
    max(1f, uiZoom * zoomBase(front,minimum) / maximum)

  /** Relative field-of-view score from real sensor dimensions, focal length and zoom-out range. */
  fun viewScore(sensorWidth: Float, sensorHeight: Float, focalLength: Float, minimumZoom: Float): Double {
    if (!sensorWidth.isFinite() || !sensorHeight.isFinite() || !focalLength.isFinite() ||
      sensorWidth <= 0 || sensorHeight <= 0 || focalLength <= 0) return 0.0
    val zoom = if (minimumZoom.isFinite() && minimumZoom > 0) minOf(1f,minimumZoom) else 1f
    // Compare the field retained by the existing 16:9 video output, not sensor area alone.
    val longEdge = minOf(maxOf(sensorWidth,sensorHeight), minOf(sensorWidth,sensorHeight) * 16f / 9f)
    return longEdge.toDouble() / (focalLength * zoom)
  }
}
