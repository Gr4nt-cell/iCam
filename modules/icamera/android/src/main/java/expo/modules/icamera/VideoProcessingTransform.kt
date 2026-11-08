package expo.modules.icamera

import kotlin.math.*

internal data class RollSample(val timeUs: Long, val radians: Float)

/** Maps gravity samples onto the recorded timeline, excluding pauses. No wall-clock timestamps. */
internal class RecordingRollTrace(private val reverseRoll: Boolean) {
  private val samples = ArrayList<RollSample>()
  private var running = false
  private var anchorNs = 0L
  private var anchorUs = 0L
  private var reference = 0f
  private var lastRaw = 0f
  private var unwrapped = 0f
  private var initialized = false

  @Synchronized fun resume(durationUs: Long, clockNs: Long, rawRoll: Float) {
    anchorUs = durationUs; anchorNs = clockNs; running = true
    add(clockNs, rawRoll)
  }
  @Synchronized fun pause() { running = false }
  @Synchronized fun add(clockNs: Long, rawRoll: Float) {
    if (!running || !rawRoll.isFinite() || clockNs < anchorNs) return
    if (!initialized) {
      reference = (round(rawRoll / (PI.toFloat() / 2)) * (PI.toFloat() / 2))
      unwrapped = rawRoll; initialized = true
    } else {
      var delta = rawRoll - lastRaw
      while (delta > PI) delta -= (2 * PI).toFloat()
      while (delta < -PI) delta += (2 * PI).toFloat()
      unwrapped += delta
    }
    lastRaw = rawRoll
    val time = anchorUs + (clockNs - anchorNs) / 1000
    // Saved front frames are mirrored only when the selfie mirror switch is on.
    val angle = (unwrapped - reference) * if (reverseRoll) -1f else 1f
    if (samples.isNotEmpty() && time < samples.last().timeUs) return
    samples.add(RollSample(time, angle))
  }
  @Synchronized fun snapshot(): List<RollSample> = samples.toList()
}

internal data class VideoProcessingSample(val timeUs: Long, val x: Float, val y: Float, val roll: Float)

/** Immutable and seek-safe; an export may ask for timestamps in any order. */
internal class VideoProcessingTimeline(private val samples: List<VideoProcessingSample>) {
  init { require(samples.isNotEmpty()); require(samples.zipWithNext().all { it.first.timeUs <= it.second.timeUs }) }
  fun at(timeUs: Long): VideoProcessingSample {
    if (timeUs <= samples.first().timeUs) return samples.first()
    if (timeUs >= samples.last().timeUs) return samples.last()
    var lo = 0; var hi = samples.lastIndex
    while (hi - lo > 1) { val mid = (lo + hi) / 2; if (samples[mid].timeUs <= timeUs) lo = mid else hi = mid }
    val a = samples[lo]; val b = samples[hi]
    val f = ((timeUs - a.timeUs).toDouble() / (b.timeUs - a.timeUs).coerceAtLeast(1)).toFloat()
    fun blend(x: Float, y: Float) = x + (y - x) * f
    return VideoProcessingSample(timeUs, blend(a.x,b.x), blend(a.y,b.y), blend(a.roll,b.roll))
  }
}

/** Geometry only. HDR pixels remain in Media3's high precision pipeline, never in an SDR bitmap. */
internal object VideoProcessingGeometry {
  fun matrix(sample: VideoProcessingSample, width: Int, height: Int, reserve: Float): FloatArray {
    require(width > 0 && height > 0 && reserve >= 1f)
    val c = cos(sample.roll.toDouble()).toFloat(); val s = sin(sample.roll.toDouble()).toFloat()
    val aspect = width.toFloat() / height
    val x = sample.x.coerceIn(-.45f, .45f); val y = sample.y.coerceIn(-.45f, .45f)
    // Inverse-map every output corner inside the source, including translation AND roll.
    val required = max((abs(c) + abs(s) / aspect) / (1 - 2 * abs(x)),
                       (abs(c) + abs(s) * aspect) / (1 - 2 * abs(y)))
    val k = max(reserve, required * 1.01f)
    val a = k*c; val b = -k*s/aspect; val d = k*s*aspect; val e = k*c
    // Bitmap analysis y points down, while Media3 normalized-device y points up.
    return floatArrayOf(a,b,-2*a*x + 2*b*y, d,e,-2*d*x + 2*e*y, 0f,0f,1f)
  }
}
