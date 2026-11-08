package expo.modules.icamera

import kotlin.math.*

/** One policy for initial binding and front/back changes. Cropping reserves real motion headroom. */
internal object VideoStabilityPolicy {
  fun crop(mode: String, stabilization: String, frontCamera: Boolean = false, hardwareStabilized: Boolean = false): Float {
    // Selfie sensors have less field of view to spare. Avoid a full second EIS crop
    // when the phone already stabilizes; retain a small reserve for software motion.
    if (frontCamera) return when {
      mode == "action" -> if (hardwareStabilized) 1.08f else 1.16f
      stabilization == "off" -> 1f
      stabilization == "horizon" -> if (hardwareStabilized) 1.04f else 1.08f
      hardwareStabilized -> 1f
      stabilization == "standard" -> 1.06f
      else -> 1.10f
    }
    return when {
      mode == "action" -> 1.28f
      stabilization == "off" -> 1f
      stabilization == "horizon" -> 1.24f
      stabilization == "standard" -> 1.10f
      else -> 1.20f
    }
  }
  fun rotationCrop(width: Float, height: Float, angle: Float, previous: Float): Float {
    if (width <= 0 || height <= 0 || !angle.isFinite()) return 1f
    var a = abs(angle.toDouble()) % Math.PI
    if (a > Math.PI / 2) a = Math.PI - a
    val needed = ((cos(a) + max(width, height) / min(width, height) * sin(a)) * 1.03).toFloat().coerceAtLeast(1f)
    // Never ease below the geometric requirement: that exposes black corners during roll changes.
    return max(needed, previous + (needed - previous) * 0.05f)
  }
  fun frameRate(ranges: List<Pair<Int, Int>>, target: Int): Pair<Int, Int>? =
    ranges.firstOrNull { it.first == target && it.second == target }
      ?: ranges.filter { it.second == target }.maxByOrNull { it.first }
      ?: ranges.minWithOrNull(compareBy<Pair<Int, Int>> { abs(it.second - target) }.thenBy { it.second - it.first })
  fun horizon(mode: String, stabilization: String) = mode == "action" || stabilization == "horizon"
}

/** Causal, frame-rate-independent camera path; does not buffer or drop recorded frames. */
internal class VideoCameraPath {
  private var x = 0.0
  private var y = 0.0
  fun reset() { x = 0.0; y = 0.0 }
  fun update(dx: Double, dy: Double, seconds: Double, crop: Float, reliable: Boolean): FloatArray {
    if (crop <= 1.001f || !seconds.isFinite() || seconds > 0.25) { reset(); return floatArrayOf(0f, 0f) }
    val dt = seconds.coerceIn(0.005, 0.1)
    val limit = ((1.0 - 1.0 / crop) * 0.5 - 0.002).coerceAtLeast(0.0)
    if (reliable && dx.isFinite() && dy.isFinite()) { x += dx; y += dy }
    val edge = max(abs(x), abs(y)) / max(limit, 0.0001)
    // Deliberate pans catch up smoothly as reserve runs low, rather than hitting a hard crop wall.
    val pressure = ((edge - 0.55) / 0.55).coerceIn(0.0, 1.0)
    val tau = if (!reliable) 0.12 else 0.70 + (0.09 - 0.70) * pressure * pressure
    val decay = exp(-dt / tau)
    x = (x * decay).coerceIn(-limit, limit)
    y = (y * decay).coerceIn(-limit, limit)
    return floatArrayOf(x.toFloat(), y.toFloat())
  }
}

/** Luma block motion with exposure-offset compensation and two-dimensional background consensus. */
internal object VideoMotionEstimator {
  fun estimate(prev: IntArray, cur: IntArray, width: Int, height: Int): DoubleArray? {
    if (width < 160 || height < 90 || prev.size != width * height || cur.size != prev.size) return null
    var offset = 0.0; var samples = 0
    for (i in prev.indices step 8) { offset += cur[i] - prev[i]; samples++ }
    offset /= samples
    if (abs(offset) > 65) return null
    val bias = offset.roundToInt()
    val radius = 6; val bw = 28; val bh = 18; val side = 2 * radius + 1
    val vectors = ArrayList<DoubleArray>()
    val costs = IntArray(side * side)
    for (by in intArrayOf(10, 36, 62)) for (bx in intArrayOf(12, 47, 85, 120)) {
      var low = 255; var high = 0
      for (y in by until by + bh step 3) for (x in bx until bx + bw step 3) {
        val v = prev[y * width + x]; low = min(low, v); high = max(high, v)
      }
      if (high - low < 18) continue
      var best = Int.MAX_VALUE; var bestX = 0; var bestY = 0
      for (dy in -radius..radius) for (dx in -radius..radius) {
        var cost = 0
        for (y in by until by + bh step 2) for (x in bx until bx + bw step 2) {
          cost += abs(cur[(y + dy) * width + x + dx] - prev[y * width + x] - bias)
        }
        costs[(dy + radius) * side + dx + radius] = cost
        if (cost < best) { best = cost; bestX = dx; bestY = dy }
      }
      if (best > (bw / 2) * (bh / 2) * 22 || abs(bestX) == radius || abs(bestY) == radius) continue
      fun refine(a: Int, b: Int, c: Int): Double {
        val denominator = a - 2.0 * b + c
        return if (denominator > 0) (0.5 * (a - c) / denominator).coerceIn(-0.5, 0.5) else 0.0
      }
      val i = (bestY + radius) * side + bestX + radius
      vectors.add(doubleArrayOf(bestX + refine(costs[i - 1], costs[i], costs[i + 1]), bestY + refine(costs[i - side], costs[i], costs[i + side])))
    }
    if (vectors.size < 3) return null
    val mx = vectors.map { it[0] }.sorted()[vectors.size / 2]
    val my = vectors.map { it[1] }.sorted()[vectors.size / 2]
    val inliers = vectors.filter { hypot(it[0] - mx, it[1] - my) <= 1.6 }
    if (inliers.size < max(3, (vectors.size + 1) / 2)) return null
    return doubleArrayOf(inliers.map { it[0] }.average(), inliers.map { it[1] }.average())
  }
}

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
