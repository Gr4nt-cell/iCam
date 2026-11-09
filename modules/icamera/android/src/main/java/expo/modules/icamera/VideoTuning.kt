package expo.modules.icamera

import kotlin.math.*

/** Conservative SDR adaptation. This cannot recover sensor-clipped detail or create 10-bit HDR. */
internal object VideoTonePolicy {
  fun gain(mean: Float, p95: Float, p99: Float): Float {
    val cap = when { p99 >= 0.98f -> 1.10f; p95 >= 0.85f -> 1.25f; else -> 1.65f }
    return (0.30f / max(mean, 0.03f)).coerceIn(1f, cap)
  }
  fun adapt(current: Float, target: Float, seconds: Float): Float {
    val tau = if (target < current) 0.28 else 0.85
    return (current + (target - current) * (1 - exp(-seconds.coerceIn(0.01f, 0.6f) / tau))).toFloat()
  }
  fun neutralGains(red: Double, green: Double, blue: Double, count: Int, pixels: Int): FloatArray {
    if (count < pixels / 8 || minOf(red, green, blue) <= 0) return floatArrayOf(1f, 1f, 1f)
    val grey = (red + green + blue) / 3.0
    return floatArrayOf((grey / red).toFloat().coerceIn(.96f, 1.04f), (grey / green).toFloat().coerceIn(.96f, 1.04f), (grey / blue).toFloat().coerceIn(.96f, 1.04f))
  }
}
