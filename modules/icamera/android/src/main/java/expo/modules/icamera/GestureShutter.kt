package expo.modules.icamera

import android.content.Context
import android.graphics.Bitmap
import android.os.Handler
import android.os.Looper
import com.google.mediapipe.framework.image.BitmapImageBuilder
import com.google.mediapipe.tasks.components.containers.NormalizedLandmark
import com.google.mediapipe.tasks.core.BaseOptions
import com.google.mediapipe.tasks.vision.core.RunningMode
import com.google.mediapipe.tasks.vision.gesturerecognizer.GestureRecognizer
import java.util.concurrent.Executors

/**
 * Palm shutter. Fires only for a deliberate open palm shown to the camera:
 *  - MediaPipe's gesture model must classify the hand as "Open_Palm" (palm side, confident), and
 *  - its 21 hand landmarks must show all five fingers straight and extended, pointing up and spread,
 *  - held for about a second (3 checks in a row).
 */
class PalmDetector(
  private val ctx: Context,
  private val onPalm: () -> Unit,
  /** "none" | "hand" | "palm" | "error:<message>" — reported when it changes */
  private val onStatus: (String) -> Unit = {},
) {
  private var lastStatus = ""
  private fun status(s: String) { if (s != lastStatus) { lastStatus = s; main.post { onStatus(s) } } }
  private val main = Handler(Looper.getMainLooper())
  private val worker = Executors.newSingleThreadExecutor()
  private var recognizer: GestureRecognizer? = null
  private var failed = false
  @Volatile private var busy = false
  private var running = false
  private var hits = 0
  private var lastFire = 0L
  /** Supplies the current viewfinder picture (main thread). */
  var frameSource: (() -> Bitmap?)? = null

  fun setEnabled(on: Boolean) {
    if (on == running) return
    running = on
    hits = 0
    if (on) main.post(tick) else main.removeCallbacks(tick)
  }

  private fun recognizer(): GestureRecognizer? {
    recognizer?.let { return it }
    if (failed) return null
    return try {
      val base = BaseOptions.builder().setModelAssetPath(MODEL).build()
      val opts = GestureRecognizer.GestureRecognizerOptions.builder()
        .setBaseOptions(base)
        .setRunningMode(RunningMode.IMAGE)
        .setNumHands(2)
        .setMinHandDetectionConfidence(0.6f)
        .setMinHandPresenceConfidence(0.6f)
        .setMinTrackingConfidence(0.5f)
        .build()
      GestureRecognizer.createFromOptions(ctx, opts).also { recognizer = it }
    } catch (e: Throwable) {
      failed = true
      status("error:" + (e.message ?: e.javaClass.simpleName).take(120))
      null
    }
  }

  private val tick = object : Runnable {
    override fun run() {
      if (!running) return
      main.postDelayed(this, 330)
      if (busy || System.currentTimeMillis() - lastFire < 4000) return
      val full = try { frameSource?.invoke() } catch (e: Throwable) { null } ?: return
      val w = 480
      val h = (full.height * w.toFloat() / full.width).toInt().coerceAtLeast(1)
      val small = Bitmap.createScaledBitmap(full, w, h, true)
      if (small !== full) full.recycle()
      busy = true
      worker.execute {
        var palm = false
        try {
          val rec = recognizer()
          if (rec != null) {
            val res = rec.recognize(BitmapImageBuilder(small).build())
            val gestures = res.gestures()
            val hands = res.landmarks()
            for (i in hands.indices) {
              // "Open_Palm" among the model's top guesses, plus our own five-finger check
              val open = gestures.getOrNull(i)?.any { it.categoryName() == "Open_Palm" && it.score() >= 0.5f } == true
              if (open && openHand(hands[i], small.width, small.height)) {
                palm = true
                break
              }
            }
            status(if (palm) "palm" else if (hands.isNotEmpty()) "hand" else "none")
          }
        } catch (e: Throwable) {
          status("error:" + (e.message ?: e.javaClass.simpleName).take(120))
        } finally {
          small.recycle()
          busy = false
        }
        main.post {
          hits = if (palm) hits + 1 else 0
          if (hits >= 2 && running) {
            hits = 0
            lastFire = System.currentTimeMillis()
            onPalm()
          }
        }
      }
    }
  }

  /** All five fingers straight, extended away from the wrist, pointing up and spread apart. */
  private fun openHand(lm: List<NormalizedLandmark>, w: Int, h: Int): Boolean {
    if (lm.size < 21) return false
    val x = FloatArray(21) { lm[it].x() * w }
    val y = FloatArray(21) { lm[it].y() * h }
    fun d(a: Int, b: Int) = Math.hypot((x[a] - x[b]).toDouble(), (y[a] - y[b]).toDouble())
    fun straight(a: Int, b: Int, c: Int, minCos: Double): Boolean {
      val ux = x[b] - x[a]; val uy = y[b] - y[a]
      val vx = x[c] - x[b]; val vy = y[c] - y[b]
      val n = Math.hypot(ux.toDouble(), uy.toDouble()) * Math.hypot(vx.toDouble(), vy.toDouble())
      return n > 0 && (ux * vx + uy * vy) / n >= minCos
    }
    val palm = d(0, 9)
    if (palm < 0.04 * minOf(w, h)) return false // hand too small / far away to judge
    // index, middle, ring, little: tip well beyond the middle joint, finger straight, pointing up
    for (f in listOf(intArrayOf(5, 6, 7, 8), intArrayOf(9, 10, 11, 12), intArrayOf(13, 14, 15, 16), intArrayOf(17, 18, 19, 20))) {
      val (mcp, pip, _, tip) = f.toList()
      if (d(tip, 0) < d(pip, 0) * 1.1) return false
      if (!straight(mcp, pip, tip, 0.55)) return false
      if (y[tip] >= y[mcp]) return false
    }
    // thumb: out to the side, straight, tip beyond its middle joint
    if (d(4, 5) < 0.3 * palm || d(4, 0) <= d(3, 0) * 0.98) return false
    // fingers fanned out (an open palm, not a pointing or "stop-sign" pinch)
    if (d(8, 20) < 0.45 * palm) return false
    // hand upright: fingertips above the wrist
    if (y[12] >= y[0]) return false
    return true
  }

  fun release() {
    setEnabled(false)
    worker.execute { try { recognizer?.close() } catch (_: Throwable) {} }
    worker.shutdown()
  }

  companion object {
    const val MODEL = "gesture_recognizer.task"
  }
}
