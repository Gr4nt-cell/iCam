package expo.modules.icamera

import android.graphics.Bitmap
import android.os.Handler
import android.os.Looper
import com.google.mlkit.vision.common.InputImage
import com.google.mlkit.vision.pose.PoseDetection
import com.google.mlkit.vision.pose.PoseLandmark
import com.google.mlkit.vision.pose.defaults.PoseDetectorOptions
import java.util.concurrent.Executors

/**
 * Palm shutter: a raised open hand (wrist above the shoulder, fingers up) held for a moment.
 * Runs ML Kit pose detection on small snapshots of the viewfinder ~3 times a second.
 */
class PalmDetector(private val onPalm: () -> Unit) {
  private val main = Handler(Looper.getMainLooper())
  private val worker = Executors.newSingleThreadExecutor()
  private val detector by lazy {
    PoseDetection.getClient(PoseDetectorOptions.Builder().setDetectorMode(PoseDetectorOptions.STREAM_MODE).build())
  }
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

  private val tick = object : Runnable {
    override fun run() {
      if (!running) return
      main.postDelayed(this, 330)
      if (busy || System.currentTimeMillis() - lastFire < 4000) return
      val full = try { frameSource?.invoke() } catch (e: Throwable) { null } ?: return
      val w = 320
      val h = (full.height * w.toFloat() / full.width).toInt().coerceAtLeast(1)
      val small = Bitmap.createScaledBitmap(full, w, h, true)
      if (small !== full) full.recycle()
      busy = true
      worker.execute {
        try {
          val pose = com.google.android.gms.tasks.Tasks.await(detector.process(InputImage.fromBitmap(small, 0)))
          val raised = palmRaised(pose, PoseLandmark.LEFT_WRIST, PoseLandmark.LEFT_SHOULDER, PoseLandmark.LEFT_INDEX, PoseLandmark.LEFT_PINKY) ||
            palmRaised(pose, PoseLandmark.RIGHT_WRIST, PoseLandmark.RIGHT_SHOULDER, PoseLandmark.RIGHT_INDEX, PoseLandmark.RIGHT_PINKY)
          main.post {
            hits = if (raised) hits + 1 else 0
            if (hits >= 2 && running) {
              hits = 0
              lastFire = System.currentTimeMillis()
              onPalm()
            }
          }
        } catch (_: Throwable) {
        } finally {
          small.recycle()
          busy = false
        }
      }
    }
  }

  private fun palmRaised(pose: com.google.mlkit.vision.pose.Pose, wristT: Int, shoulderT: Int, indexT: Int, pinkyT: Int): Boolean {
    val wrist = pose.getPoseLandmark(wristT) ?: return false
    val shoulder = pose.getPoseLandmark(shoulderT) ?: return false
    val index = pose.getPoseLandmark(indexT) ?: return false
    val pinky = pose.getPoseLandmark(pinkyT) ?: return false
    if (wrist.inFrameLikelihood < 0.6f || shoulder.inFrameLikelihood < 0.5f || index.inFrameLikelihood < 0.5f) return false
    val w = wrist.position
    val s = shoulder.position
    val i = index.position
    val p = pinky.position
    val handLen = Math.hypot((i.x - w.x).toDouble(), (i.y - w.y).toDouble())
    return w.y < s.y && // hand raised above the shoulder
      i.y < w.y && p.y < w.y && // fingers pointing up (open palm, upright)
      handLen > 6.0
  }

  fun release() {
    setEnabled(false)
    worker.execute { try { detector.close() } catch (_: Throwable) {} }
    worker.shutdown()
  }
}

