package expo.modules.icamera

import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
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

/** Voice shutter: listens for "cheese" with the phone's speech recognizer (offline when available). */
class VoiceShutter(private val ctx: Context, private val onWord: () -> Unit, private val onError: (String) -> Unit) {
  private val main = Handler(Looper.getMainLooper())
  private var recognizer: SpeechRecognizer? = null
  private var running = false
  private var lastFire = 0L

  fun setEnabled(on: Boolean) {
    if (on == running) return
    running = on
    if (on) start() else stop()
  }

  private fun heard(list: ArrayList<String>?): Boolean =
    list?.any { it.lowercase().contains("cheese") } == true

  private fun start() {
    if (!running) return
    if (!SpeechRecognizer.isRecognitionAvailable(ctx)) {
      running = false
      onError("Voice shutter needs a speech recognition service on this phone")
      return
    }
    val r = recognizer ?: SpeechRecognizer.createSpeechRecognizer(ctx).also { recognizer = it }
    r.setRecognitionListener(object : RecognitionListener {
      override fun onReadyForSpeech(params: Bundle?) {}
      override fun onBeginningOfSpeech() {}
      override fun onRmsChanged(rmsdB: Float) {}
      override fun onBufferReceived(buffer: ByteArray?) {}
      override fun onEndOfSpeech() {}
      override fun onEvent(eventType: Int, params: Bundle?) {}
      override fun onPartialResults(partial: Bundle?) {
        if (heard(partial?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION))) fire()
      }
      override fun onResults(results: Bundle?) {
        if (heard(results?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION))) fire()
        restart(250)
      }
      override fun onError(error: Int) {
        if (error == SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS) {
          running = false
          onError("Voice shutter needs microphone permission")
          return
        }
        restart(if (error == SpeechRecognizer.ERROR_RECOGNIZER_BUSY) 1200L else 400L)
      }
    })
    val intent = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
      putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
      putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true)
      putExtra(RecognizerIntent.EXTRA_PREFER_OFFLINE, true)
      putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 5)
      putExtra(RecognizerIntent.EXTRA_CALLING_PACKAGE, ctx.packageName)
    }
    try { r.startListening(intent) } catch (e: Throwable) { restart(1500) }
  }

  private fun fire() {
    val now = System.currentTimeMillis()
    if (now - lastFire < 2500) return
    lastFire = now
    onWord()
  }

  private fun restart(delay: Long) {
    if (!running) return
    main.postDelayed({ if (running) { try { recognizer?.cancel() } catch (_: Throwable) {}; start() } }, delay)
  }

  private fun stop() {
    main.removeCallbacksAndMessages(null)
    try { recognizer?.cancel() } catch (_: Throwable) {}
    try { recognizer?.destroy() } catch (_: Throwable) {}
    recognizer = null
  }

  fun release() { running = false; stop() }
}
