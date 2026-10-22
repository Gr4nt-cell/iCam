package expo.modules.icamera

import android.Manifest
import android.annotation.SuppressLint
import android.content.Context
import android.content.pm.PackageManager
import android.hardware.Sensor
import android.hardware.SensorEvent
import android.hardware.SensorEventListener
import android.hardware.SensorManager
import android.hardware.camera2.CaptureRequest
import android.hardware.camera2.params.RggbChannelVector
import android.util.Range
import android.view.View
import android.view.ViewGroup
import android.view.MotionEvent
import androidx.camera.camera2.interop.Camera2CameraControl
import androidx.camera.camera2.interop.Camera2CameraInfo
import androidx.camera.camera2.interop.CaptureRequestOptions
import androidx.camera.camera2.interop.ExperimentalCamera2Interop
import androidx.camera.core.Camera
import androidx.camera.core.CameraEffect
import androidx.camera.core.CameraSelector
import androidx.camera.core.CompositionSettings
import androidx.camera.core.ConcurrentCamera
import androidx.camera.core.DynamicRange
import androidx.camera.core.FocusMeteringAction
import androidx.camera.core.ImageCapture
import androidx.camera.core.ImageCaptureException
import androidx.camera.core.MirrorMode
import androidx.camera.core.Preview
import androidx.camera.core.UseCaseGroup
import androidx.camera.extensions.ExtensionMode
import androidx.camera.extensions.ExtensionsManager
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.video.ExperimentalHighSpeedVideo
import androidx.camera.video.ExperimentalPersistentRecording
import androidx.camera.video.FallbackStrategy
import androidx.camera.video.FileOutputOptions
import androidx.camera.video.HighSpeedVideoSessionConfig
import androidx.camera.video.Quality
import androidx.camera.video.QualitySelector
import androidx.camera.video.Recorder
import androidx.camera.video.Recording
import androidx.camera.video.VideoCapture
import androidx.camera.video.VideoRecordEvent
import androidx.camera.view.PreviewView
import androidx.core.content.ContextCompat
import androidx.lifecycle.LifecycleOwner
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.viewevent.EventDispatcher
import expo.modules.kotlin.views.ExpoView
import java.io.File
import kotlin.math.ln
import kotlin.math.max
import kotlin.math.pow
import kotlin.math.roundToInt

/**
 * One CameraX surface for every capture mode:
 *  photo  – preview + still capture; JS asks for bursts that feed the HDR+ merge
 *  night  – vendor Night extension when the phone has one, else a burst
 *  pro    – manual ISO / shutter / white balance / focus via Camera2 interop, photo + video
 *  video  – 4K/1080p, 30/60 fps, HDR (HLG 10-bit), standard or cinematic stabilization
 *  action – 1080p60 with maximum stabilization
 *  slowmo – high-speed capture saved as ready-to-play slow motion
 *  dual   – front + back recorded together, picture-in-picture
 */
@SuppressLint("ViewConstructor")
class ICameraView(context: Context, appContext: AppContext) : ExpoView(context, appContext) {
  override val shouldUseAndroidLayout = true

  private val onReady by EventDispatcher()
  private val onError by EventDispatcher()
  private val onRecordingFinished by EventDispatcher()
  private val onPhotosCaptured by EventDispatcher()
  private val onDualChange by EventDispatcher()
  private val onPortraitStatus by EventDispatcher()
  private val onRecordingState by EventDispatcher()
  private val onGesture by EventDispatcher()

  companion object {
    private val PHOTO_MODES = setOf("photo", "portrait", "night", "pro", "macro")
  }

  private val previewView = PreviewView(context).apply {
    implementationMode = PreviewView.ImplementationMode.COMPATIBLE
    scaleType = PreviewView.ScaleType.FILL_CENTER
    layoutParams = ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
  }
  private val executor = ContextCompat.getMainExecutor(context)

  private var provider: ProcessCameraProvider? = null
  private var extensions: ExtensionsManager? = null
  private var camera: Camera? = null
  private var imageCapture: ImageCapture? = null
  private var videoCapture: VideoCapture<Recorder>? = null
  private var recording: Recording? = null
  private var slowFps = 0
  private var usingNightExtension = false // true whenever a vendor extension handles processing
  private var activeExtension: String? = null

  // Props
  private var mode = "photo"
  private var facing = "back"
  private var dualPrimary = "back"
  private var zoom = 1f
  private var ev = 0.0
  private var iso = 0
  private var shutterNs = 0L
  private var wb = "auto"
  private var kelvin = 5500
  private var focus = -1f
  private var flash = "off"
  private var torch = false
  private var mirror = true
  private var audio = true
  private var active = true
  private var videoQuality = "uhd"
  private var fps = 30
  private var hdrVideo = false
  private var stabilization = "cinematic"
  private var nightExtension = true

  private var currentPreview: Preview? = null
  // Dual-camera picture-in-picture: centre of the small window (0..1, y down) and its width share
  private var pipX = 0.78f
  private var pipY = 0.2f
  private var pipSize = 0.34f

  private var aspect = "4:3"
  private var previewFit = true

  private var rebindQueued = false

  /** Expo events can't carry null values – drop them. */
  @Suppress("UNCHECKED_CAST")
  private fun clean(m: Map<String, Any?>): Map<String, Any> = m.filterValues { it != null } as Map<String, Any>
  private fun emitReady(m: Map<String, Any?>) = onReady(clean(m))
  private fun emitError(m: Map<String, Any?>) = onError(clean(m))
  private fun emitRecordingFinished(m: Map<String, Any?>) = onRecordingFinished(clean(m))
  private fun emitPhotosCaptured(m: Map<String, Any?>) = onPhotosCaptured(clean(m))
  private fun emitDualChange(m: Map<String, Any?>) = onDualChange(clean(m))
  private fun emitPortraitStatus(m: Map<String, Any?>) = onPortraitStatus(clean(m))
  private fun emitRecordingState(m: Map<String, Any?>) = onRecordingState(clean(m))
  private fun emitGesture(m: Map<String, Any?>) = onGesture(clean(m))

  private var burstEvOffset = 0.0

  // Dual mode: a real, draggable inset preview (tap = swap). Recording switches to the
  // camera-composited stream so the saved video matches what's on screen.
  private val pipPreview = PreviewView(context).apply {
    implementationMode = PreviewView.ImplementationMode.COMPATIBLE
    scaleType = PreviewView.ScaleType.FILL_CENTER
  }
  private fun dp(v: Float) = v * resources.displayMetrics.density
  private val pipContainer = android.widget.FrameLayout(context).apply {
    visibility = View.GONE
    clipToOutline = true
    outlineProvider = object : android.view.ViewOutlineProvider() {
      override fun getOutline(v: View, o: android.graphics.Outline) {
        o.setRoundRect(0, 0, v.width, v.height, dp(18f))
      }
    }
    foreground = android.graphics.drawable.GradientDrawable().apply {
      cornerRadius = dp(18f)
      setColor(android.graphics.Color.TRANSPARENT)
      setStroke(dp(1.5f).toInt(), android.graphics.Color.argb(210, 255, 255, 255))
    }
    elevation = dp(8f)
    addView(pipPreview, android.widget.FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
  }
  private val root = android.widget.FrameLayout(context)
  private var portraitProcessor: PortraitProcessor? = null
  private var bokeh = 0.6f
  private var dualComposed = false
  private var pendingDualRecord = false

  init {
    addView(root, ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
    root.addView(previewView)
    root.addView(
      pipContainer,
      android.widget.FrameLayout.LayoutParams(1, 1, android.view.Gravity.TOP or android.view.Gravity.START),
    )
  }

  /* ---------------- props ---------------- */

  private fun <T> rebindOnChange(old: T, new: T, set: (T) -> Unit) {
    if (old != new) { set(new); scheduleRebind() }
  }

  fun setMode(v: String) = rebindOnChange(mode, v) { mode = it; post { updateGestures() } }
  fun setFacing(v: String) = rebindOnChange(facing, v) { facing = it }
  fun setDualPrimary(v: String) = rebindOnChange(dualPrimary, v) { dualPrimary = it }
  fun setMirror(v: Boolean) = rebindOnChange(mirror, v) { mirror = it }
  fun setActive(v: Boolean) = rebindOnChange(active, v) { active = it; post { updateGestures() } }
  fun setVideoQuality(v: String) = rebindOnChange(videoQuality, v) { videoQuality = it }
  fun setFps(v: Int) = rebindOnChange(fps, v) { fps = it }
  fun setHdrVideo(v: Boolean) = rebindOnChange(hdrVideo, v) { hdrVideo = it }
  fun setStabilization(v: String) = rebindOnChange(stabilization, v) { stabilization = it }
  fun setNightExtension(v: Boolean) = rebindOnChange(nightExtension, v) { nightExtension = it }
  fun setAudio(v: Boolean) { audio = v }
  fun setAspect(v: String) = rebindOnChange(aspect, v) { aspect = it }
  fun setBokeh(v: Float) {
    bokeh = v.coerceIn(0f, 1f)
    portraitProcessor?.strength = bokeh
  }
  /** Live filter: [sat, contrast, warmth, fade, mono, vignette]; empty / natural = none. */
  private var filterParams = FloatArray(0)
  private fun filterActive(f: FloatArray) = f.size >= 6 &&
    (Math.abs(f[0] - 1f) > 0.001f || Math.abs(f[1] - 1f) > 0.001f || f[2] != 0f || f[3] != 0f || f[4] != 0f || f[5] != 0f)
  /* ---------------- palm shutter ---------------- */
  private var palmOn = false
  private val palm by lazy {
    PalmDetector(context, { emitGesture(mapOf("kind" to "palm")) }, { st -> emitGesture(mapOf("kind" to "status", "status" to st)) }).also { d ->
      d.frameSource = { try { previewView.bitmap } catch (e: Throwable) { null } }
    }
  }
  fun setPalmShutter(v: Boolean) { palmOn = v; updateGestures() }
  /** Gestures run only in photo modes while the camera is live and nothing is being recorded. */
  private fun updateGestures() {
    val photo = mode in PHOTO_MODES
    val live = active && isAttachedToWindow && recording == null
    val on = palmOn && photo && live
    palm.setEnabled(on)
    if (!on) emitGesture(mapOf("kind" to "status", "status" to "off"))
  }

  /* ---------------- capture sounds ---------------- */
  private var soundOn = true
  private val sounds by lazy {
    android.media.MediaActionSound().apply {
      try {
        load(android.media.MediaActionSound.SHUTTER_CLICK)
        load(android.media.MediaActionSound.START_VIDEO_RECORDING)
        load(android.media.MediaActionSound.STOP_VIDEO_RECORDING)
      } catch (_: Throwable) {}
    }
  }
  fun setShutterSound(v: Boolean) { soundOn = v }
  private fun playSound(kind: Int) { if (soundOn) try { sounds.play(kind) } catch (_: Throwable) {} }

  /* ---------------- vivid viewfinder ---------------- */
  /**
   * Photo modes: a GPU colour matrix on the viewfinder (saturation + a touch of contrast) so the
   * preview looks like the finished, vivid photo. Video modes get the same look inside the GL
   * pipeline instead (so the recording matches), and filters render there too.
   */
  private fun applyPreviewColor() {
    val tv = findTexture(previewView) ?: return
    val vivid = mode in PHOTO_MODES && !effectPreview
    if (!vivid) { tv.setLayerType(View.LAYER_TYPE_NONE, null); return }
    val cm = android.graphics.ColorMatrix().apply { setSaturation(1.28f) }
    val c = 1.06f
    val t = (1f - c) * 128f
    cm.postConcat(android.graphics.ColorMatrix(floatArrayOf(c, 0f, 0f, 0f, t, 0f, c, 0f, 0f, t, 0f, 0f, c, 0f, t, 0f, 0f, 0f, 1f, 0f)))
    val paint = android.graphics.Paint().apply { colorFilter = android.graphics.ColorMatrixColorFilter(cm) }
    tv.setLayerType(View.LAYER_TYPE_HARDWARE, paint)
  }
  private fun findTexture(v: View): android.view.TextureView? {
    if (v is android.view.TextureView) return v
    if (v is ViewGroup) for (i in 0 until v.childCount) findTexture(v.getChildAt(i))?.let { return it }
    return null
  }

  private var faceSmoothing = 0f
  fun setFaceSmoothing(v: Float) {
    faceSmoothing = v.coerceIn(0f, 1f)
    portraitProcessor?.smoothing = faceSmoothing
  }

  fun setFilterParams(v: FloatArray) {
    val wasActive = filterActive(filterParams)
    filterParams = v
    portraitProcessor?.filter = if (filterActive(v)) v else null
    // Photo modes only route the preview through the GPU effect while a filter is on
    if (wasActive != filterActive(v) && mode in PHOTO_MODES) scheduleRebind()
  }

  fun setPreviewFit(v: Boolean) {
    previewFit = v
    previewView.scaleType = if (v) PreviewView.ScaleType.FIT_CENTER else PreviewView.ScaleType.FILL_CENTER
  }

  private fun resolutionSelector(): androidx.camera.core.resolutionselector.ResolutionSelector =
    androidx.camera.core.resolutionselector.ResolutionSelector.Builder()
      .setAspectRatioStrategy(
        if (aspect == "16:9") androidx.camera.core.resolutionselector.AspectRatioStrategy.RATIO_16_9_FALLBACK_AUTO_STRATEGY
        else androidx.camera.core.resolutionselector.AspectRatioStrategy.RATIO_4_3_FALLBACK_AUTO_STRATEGY,
      )
      .build()
  fun setDualPip(x: Float, y: Float, size: Float) {
    pipX = x.coerceIn(0f, 1f); pipY = y.coerceIn(0f, 1f); pipSize = size.coerceIn(0.2f, 0.6f)
    layoutPip()
  }

  /** Called continuously while the user drags the inset (no rebind, instant). */
  fun movePip(x: Float, y: Float) {
    pipX = x.coerceIn(0f, 1f); pipY = y.coerceIn(0f, 1f)
    layoutPip()
  }

  private fun layoutPip() {
    if (width == 0 || height == 0) return
    val w = (pipSize * width).toInt()
    val h = (w * 4f / 3f).toInt()
    val lp = pipContainer.layoutParams as android.widget.FrameLayout.LayoutParams
    if (lp.width != w || lp.height != h) {
      lp.width = w; lp.height = h
      pipContainer.layoutParams = lp
      pipContainer.measure(
        MeasureSpec.makeMeasureSpec(w, MeasureSpec.EXACTLY),
        MeasureSpec.makeMeasureSpec(h, MeasureSpec.EXACTLY),
      )
      pipContainer.layout(0, 0, w, h)
      pipPreview.measure(
        MeasureSpec.makeMeasureSpec(w, MeasureSpec.EXACTLY),
        MeasureSpec.makeMeasureSpec(h, MeasureSpec.EXACTLY),
      )
      pipPreview.layout(0, 0, w, h)
      pipContainer.invalidateOutline()
    }
    pipContainer.translationX = (pipX * width - w / 2f).coerceIn(0f, (width - w).toFloat())
    pipContainer.translationY = (pipY * height - h / 2f).coerceIn(0f, (height - h).toFloat())
  }

  override fun onSizeChanged(w: Int, h: Int, oldw: Int, oldh: Int) {
    super.onSizeChanged(w, h, oldw, oldh)
    post { layoutPip() }
  }

  private fun installPipTouch() {
    var downX = 0f; var downY = 0f; var startTx = 0f; var startTy = 0f; var moved = false
    pipContainer.setOnTouchListener { v, e ->
      when (e.actionMasked) {
        MotionEvent.ACTION_DOWN -> {
          downX = e.rawX; downY = e.rawY
          startTx = v.translationX; startTy = v.translationY
          moved = false
          v.parent?.requestDisallowInterceptTouchEvent(true)
          v.animate().scaleX(1.04f).scaleY(1.04f).setDuration(120).start()
        }
        MotionEvent.ACTION_MOVE -> {
          val dx = e.rawX - downX
          val dy = e.rawY - downY
          if (!moved && Math.abs(dx) + Math.abs(dy) > dp(8f)) moved = true
          if (moved && recording == null) {
            v.translationX = (startTx + dx).coerceIn(0f, (width - v.width).toFloat())
            v.translationY = (startTy + dy).coerceIn(0f, (height - v.height).toFloat())
          }
        }
        MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> {
          v.animate().scaleX(1f).scaleY(1f).setDuration(120).start()
          if (!moved && e.actionMasked == MotionEvent.ACTION_UP) {
            if (recording == null) {
              dualPrimary = if (dualPrimary == "front") "back" else "front"
              emitDualChange(mapOf("x" to pipX.toDouble(), "y" to pipY.toDouble(), "size" to pipSize.toDouble(), "primary" to dualPrimary))
              scheduleRebind()
            }
          } else if (moved) {
            pipX = (v.translationX + v.width / 2f) / width
            pipY = (v.translationY + v.height / 2f) / height
            emitDualChange(mapOf("x" to pipX.toDouble(), "y" to pipY.toDouble(), "size" to pipSize.toDouble(), "primary" to dualPrimary))
          }
        }
      }
      true
    }
  }

  fun setZoom(v: Float) { zoom = v; applyZoom() }

  /** Horizon lock crops by this factor; the lens zooms out by the same amount so framing stays put. */
  private var horizonCrop = 1f

  /** True while the GPU effect renders the preview (video modes, or a live filter in photo modes). */
  private var effectPreview = false
  /** Zoom beyond the lens/hardware maximum, done digitally (preview + recording; photos are cropped in JS). */
  private var digitalZoom = 1f
  private var zoomAnim: android.animation.ValueAnimator? = null
  /** Macro fallback: hold the logical camera at the tele-macro lens's zoom. */
  private var macroZoom: Float? = null

  private fun applyZoom() {
    val cam = camera ?: return
    val z = cam.cameraInfo.zoomState.value
    val zMin = z?.minZoomRatio ?: 1f
    val zMax = z?.maxZoomRatio ?: 1f
    var hw = (macroZoom ?: zoom).coerceIn(zMin, zMax)
    if (horizonCrop > 1.01f) hw = maxOf(zMin, hw / horizonCrop)
    // Big jumps (tapping a lens pill) glide instead of cutting, so lens changes are smooth on video too
    val from = z?.zoomRatio ?: hw
    zoomAnim?.cancel()
    if (Math.abs(Math.log((hw / from).toDouble())) > 0.2) {
      zoomAnim = android.animation.ValueAnimator.ofFloat(0f, 1f).apply {
        duration = 320
        interpolator = android.view.animation.DecelerateInterpolator()
        val lf = Math.log(from.toDouble())
        val lt = Math.log(hw.toDouble())
        addUpdateListener { a ->
          val t = a.animatedValue as Float
          camera?.cameraControl?.setZoomRatio(Math.exp(lf + (lt - lf) * t).toFloat())
        }
        start()
      }
    } else cam.cameraControl.setZoomRatio(hw)
    digitalZoom = if (mode == "dual" || mode == "slowmo") 1f else maxOf(1f, zoom / zMax)
    portraitProcessor?.digitalZoom = if (effectPreview) digitalZoom else 1f
    applyPreviewTransform()
  }

  /**
   * Preview view transform: digital zoom (when the effect isn't doing it) and selfie mirroring that
   * follows the toggle — with mirror off the preview shows the true (un-mirrored) view you'll save.
   */
  private fun applyPreviewTransform() {
    val s = if (effectPreview) 1f else digitalZoom
    val mainFront = if (mode == "dual") dualPrimary == "front" else facing == "front"
    val sx = if (mainFront && !mirror) -s else s
    // mirror flips apply instantly; zoom changes glide
    if (Math.signum(previewView.scaleX) != Math.signum(sx)) { previewView.animate().cancel(); previewView.scaleX = sx; previewView.scaleY = s }
    else previewView.animate().scaleX(sx).scaleY(s).setDuration(180).start()
    val pipFront = mode == "dual" && dualPrimary != "front"
    pipPreview.scaleX = if (pipFront && !mirror) -1f else 1f
  }

  /* ---- gravity sensor for horizon lock ---- */
  private var sensorOn = false
  private val gravity = FloatArray(3)
  private val rollListener = object : SensorEventListener {
    override fun onSensorChanged(e: SensorEvent) {
      if (e.sensor.type == Sensor.TYPE_ACCELEROMETER) {
        for (i in 0..2) gravity[i] = gravity[i] * 0.85f + e.values[i] * 0.15f
      } else for (i in 0..2) gravity[i] = e.values[i]
      val gx = gravity[0]
      val gy = gravity[1]
      // Phone lying flat: the roll is undefined, keep the last angle
      if (Math.hypot(gx.toDouble(), gy.toDouble()) < 3.0) return
      portraitProcessor?.targetRoll = Math.atan2(gx.toDouble(), gy.toDouble()).toFloat()
    }
    override fun onAccuracyChanged(s: Sensor?, a: Int) {}
  }

  private fun setRollSensor(on: Boolean) {
    if (on == sensorOn) return
    val sm = context.getSystemService(Context.SENSOR_SERVICE) as? SensorManager ?: return
    if (on) {
      val sensor = sm.getDefaultSensor(Sensor.TYPE_GRAVITY) ?: sm.getDefaultSensor(Sensor.TYPE_ACCELEROMETER) ?: return
      sm.registerListener(rollListener, sensor, SensorManager.SENSOR_DELAY_GAME)
    } else sm.unregisterListener(rollListener)
    sensorOn = on
  }
  fun setEvBias(v: Double) { ev = v; applyControls() }
  fun setIso(v: Int) { iso = v; applyControls() }
  fun setShutterNs(v: Long) { shutterNs = v; applyControls() }
  fun setWhiteBalance(v: String) { wb = v; applyControls() }
  fun setKelvin(v: Int) { kelvin = v; applyControls() }
  fun setFocusDistance(v: Float) { focus = v; applyControls() }
  fun setFlash(v: String) { flash = v; imageCapture?.flashMode = flashMode() }
  fun setTorch(v: Boolean) {
    torch = v
    camera?.let { if (it.cameraInfo.hasFlashUnit()) it.cameraControl.enableTorch(v) }
  }

  private fun flashMode() = when (flash) {
    "on" -> ImageCapture.FLASH_MODE_ON
    "auto" -> ImageCapture.FLASH_MODE_AUTO
    else -> ImageCapture.FLASH_MODE_OFF
  }

  /* ---------------- lifecycle ---------------- */

  override fun onAttachedToWindow() {
    super.onAttachedToWindow()
    scheduleRebind(150)
  }

  override fun onDetachedFromWindow() {
    super.onDetachedFromWindow()
    recording?.stop()
    recording = null
    provider?.unbindAll()
    setRollSensor(false)
    palm.setEnabled(false)
    portraitProcessor?.release()
    portraitProcessor = null
    camera = null
  }

  private fun scheduleRebind(delayMs: Long = 0) {
    if (rebindQueued) return
    rebindQueued = true
    postDelayed({ rebindQueued = false; rebind() }, delayMs)
  }

  private fun withProvider(block: (ProcessCameraProvider) -> Unit) {
    provider?.let { return block(it) }
    val f = ProcessCameraProvider.getInstance(context)
    f.addListener({
      try {
        val p = f.get()
        provider = p
        val ef = ExtensionsManager.getInstanceAsync(context, p)
        ef.addListener({
          extensions = try { ef.get() } catch (e: Throwable) { null }
          block(p)
        }, executor)
      } catch (e: Throwable) {
        emitError("Camera unavailable: ${e.message}")
      }
    }, executor)
  }

  private fun rebind() {
    if (!isAttachedToWindow) return
    if (recording != null) {
      // A persistent recording keeps going while we move it to the other camera
      if (persistentRec && (mode == "video" || mode == "action")) switchCameraWhileRecording()
      return
    }
    val owner = appContext.currentActivity as? LifecycleOwner
    if (owner == null) { emitError("Camera needs an active screen"); return }
    withProvider { p ->
      try {
        p.unbindAll()
        camera = null; imageCapture = null; videoCapture = null
        usingNightExtension = false; activeExtension = null; slowFps = 0; horizonCrop = 1f
        setRollSensor(false)
        if (!active) return@withProvider
        if (mode != "dual") { dualComposed = false; pendingDualRecord = false }
        pipContainer.visibility = View.GONE
        when (mode) {
          "dual" -> bindDual(p, owner)
          "slowmo" -> bindSlowMo(p, owner)
          "video", "action", "pvideo" -> bindVideo(p, owner)
          "pro" -> bindPro(p, owner)
          "macro" -> bindMacro(p, owner)
          else -> bindPhoto(p, owner)
        }
        applyZoom()
        applyPreviewColor()
        postDelayed({ applyPreviewColor() }, 400) // the viewfinder's surface view appears asynchronously
        if (pendingDualRecord && mode == "dual" && dualComposed) {
          pendingDualRecord = false
          postDelayed({ startRecording() }, 250)
        }
        setTorch(torch)
        applyControls()
        val z = camera?.cameraInfo?.zoomState?.value
        emitReady(
          mapOf(
            "mode" to mode,
            "slowMotionFps" to slowFps,
            "nightExtension" to (activeExtension == "night"),
            "extension" to activeExtension,
            "zoomMin" to (z?.minZoomRatio ?: 1f).toDouble(),
            "zoomMax" to (z?.maxZoomRatio ?: 1f).toDouble(),
            "hasFlash" to (camera?.cameraInfo?.hasFlashUnit() ?: false),
            "horizonLock" to sensorOn,
          ),
        )
      } catch (e: Throwable) {
        emitError(e.message ?: e.toString())
      }
    }
  }

  private fun selector(f: String) =
    if (f == "front") CameraSelector.DEFAULT_FRONT_CAMERA else CameraSelector.DEFAULT_BACK_CAMERA

  /** Optical image stabilization, when the lens has it (combined with electronic stabilization for video). */
  @OptIn(ExperimentalCamera2Interop::class)
  @androidx.annotation.OptIn(markerClass = [ExperimentalCamera2Interop::class])
  private fun oisSupported(info: androidx.camera.core.CameraInfo): Boolean = try {
    Camera2CameraInfo.from(info)
      .getCameraCharacteristic(android.hardware.camera2.CameraCharacteristics.LENS_INFO_AVAILABLE_OPTICAL_STABILIZATION)
      ?.contains(CaptureRequest.LENS_OPTICAL_STABILIZATION_MODE_ON) == true
  } catch (e: Throwable) { false }

  @OptIn(ExperimentalCamera2Interop::class)
  @androidx.annotation.OptIn(markerClass = [ExperimentalCamera2Interop::class])
  private fun newPreview(stabilized: Boolean = false, ois: Boolean = false, matchAspect: Boolean = false): Preview {
    val b = Preview.Builder()
    if (matchAspect) b.setResolutionSelector(resolutionSelector())
    if (stabilized) b.setPreviewStabilizationEnabled(true)
    if (ois) {
      androidx.camera.camera2.interop.Camera2Interop.Extender(b)
        .setCaptureRequestOption(CaptureRequest.LENS_OPTICAL_STABILIZATION_MODE, CaptureRequest.LENS_OPTICAL_STABILIZATION_MODE_ON)
    }
    return b.build().also {
      it.setSurfaceProvider(previewView.surfaceProvider)
      currentPreview = it
    }
  }

  private fun newImageCapture(): ImageCapture =
    ImageCapture.Builder()
      .setResolutionSelector(resolutionSelector())
      .setCaptureMode(ImageCapture.CAPTURE_MODE_MINIMIZE_LATENCY)
      .setJpegQuality(100)
      .setFlashMode(flashMode())
      .build()

  /**
   * Photo modes use the phone maker's own processing through CameraX Extensions:
   * Photo → vendor HDR (or Auto), Portrait → vendor Bokeh (real depth), Night → vendor Night.
   * One full-quality frame; no multi-frame merging in the app.
   */
  private fun bindPhoto(p: ProcessCameraProvider, owner: LifecycleOwner) {
    val base = selector(facing)
    if (filterActive(filterParams)) {
      // Live filter preview through the GPU effect (phone-maker extensions can't run effects)
      try {
        val ic = ImageCapture.Builder()
          .setResolutionSelector(resolutionSelector())
          .setCaptureMode(ImageCapture.CAPTURE_MODE_MAXIMIZE_QUALITY)
          .setJpegQuality(100)
          .setFlashMode(flashMode())
          .build()
        val proc = portraitProcessor ?: PortraitProcessor().also { portraitProcessor = it }
        proc.blurEnabled = false
        proc.enhance = true
        proc.horizonLock = false
        proc.stabCrop = 1f
        proc.frontCamera = facing == "front"
        proc.mirrorVideo = false
        proc.filter = filterParams
        proc.smoothing = 0f // photos are smoothed when processed
        val group = UseCaseGroup.Builder()
          .addUseCase(newPreview(false, oisSupported(p.getCameraInfo(base)), true))
          .addUseCase(ic)
          .addEffect(PortraitVideoEffect(proc, CameraEffect.PREVIEW))
          .build()
        camera = p.bindToLifecycle(owner, base, group)
        imageCapture = ic
        effectPreview = true
        return
      } catch (e: Throwable) {
        p.unbindAll()
        effectPreview = false
      }
    }
    var sel = base
    val ext = extensions
    val wanted: List<Pair<Int, String>> = when (mode) {
      "night" -> if (nightExtension) listOf(ExtensionMode.NIGHT to "night") else emptyList()
      "portrait" -> listOf(ExtensionMode.BOKEH to "bokeh")
      "photo" -> listOf(ExtensionMode.HDR to "hdr", ExtensionMode.AUTO to "auto")
      else -> emptyList()
    }
    if (ext != null) {
      for ((m, name) in wanted) {
        if (try { ext.isExtensionAvailable(base, m) } catch (e: Throwable) { false }) {
          sel = ext.getExtensionEnabledCameraSelector(base, m)
          activeExtension = name
          usingNightExtension = true
          break
        }
      }
    }
    val ic = ImageCapture.Builder()
      .setResolutionSelector(resolutionSelector())
      .setCaptureMode(ImageCapture.CAPTURE_MODE_MAXIMIZE_QUALITY)
      .setJpegQuality(100)
      .setFlashMode(flashMode())
      .build()
    val ois = activeExtension == null && oisSupported(p.getCameraInfo(base))
    camera = try {
      p.bindToLifecycle(owner, sel, newPreview(false, ois, true), ic)
    } catch (e: Throwable) {
      // Extension refused this configuration: fall back to the plain camera
      p.unbindAll()
      activeExtension = null
      usingNightExtension = false
      p.bindToLifecycle(owner, base, newPreview(false, false, true), ic)
    }
    imageCapture = ic
  }

  private fun buildRecorder(quality: Quality, bitrate: Int): Recorder =
    Recorder.Builder()
      .setQualitySelector(
        QualitySelector.from(quality, FallbackStrategy.lowerQualityOrHigherThan(Quality.SD)),
      )
      .setTargetVideoEncodingBitRate(bitrate)
      .build()

  /** Front/back switch mid-recording: same VideoCapture (same file), re-bound to the other camera. */
  private fun switchCameraWhileRecording() {
    val owner = appContext.currentActivity as? LifecycleOwner ?: return
    val vc = videoCapture ?: return
    if (portraitProcessor == null || !effectPreview) {
      // Without the GPU pipeline the two cameras' clocks can't be joined into one playable clip
      facing = if (facing == "front") "back" else "front"
      emitError("Switching cameras while recording needs HDR video turned off")
      return
    }
    withProvider { p ->
      try {
        p.unbindAll()
        val sel = selector(facing)
        val info = p.getCameraInfo(sel)
        val front = facing == "front"
        val stab = !front && (try { Preview.getPreviewCapabilities(info).isStabilizationSupported } catch (e: Throwable) { false })
        val preview = newPreview(stab, oisSupported(info))
        val proc = portraitProcessor
        camera = if (proc != null && effectPreview) {
          proc.frontCamera = front
          proc.horizonLock = !front && (mode == "action" || stabilization == "horizon")
          proc.stabCrop = if (front) 1.06f else if (mode == "action") 1.16f else if (stabilization == "off") 1f else 1.12f
          setRollSensor(proc.horizonLock)
          val group = UseCaseGroup.Builder().addUseCase(preview).addUseCase(vc).addEffect(PortraitVideoEffect(proc)).build()
          p.bindToLifecycle(owner, sel, group)
        } else {
          p.bindToLifecycle(owner, sel, preview, vc)
        }
        applyZoom()
        setTorch(torch)
        applyControls()
      } catch (e: Throwable) {
        emitError("Couldn't switch camera while recording: ${e.message}")
      }
    }
  }

  private fun bindVideo(p: ProcessCameraProvider, owner: LifecycleOwner) {
    val sel = selector(facing)
    val info = p.getCameraInfo(sel)
    val action = mode == "action"
    val portraitVideo = mode == "pvideo"
    val selfieVideo = facing == "front"
    val uhd = !action && !portraitVideo && !selfieVideo && videoQuality == "uhd"
    val targetFps = if (action) 60 else if (portraitVideo) 30 else fps
    val recorder = if (selfieVideo) {
      // Selfie video: 4:3 like selfie photos, so the framing (zoom) matches
      Recorder.Builder()
        .setQualitySelector(QualitySelector.from(Quality.FHD, FallbackStrategy.lowerQualityOrHigherThan(Quality.SD)))
        .setAspectRatio(androidx.camera.core.AspectRatio.RATIO_4_3)
        .setTargetVideoEncodingBitRate(20_000_000)
        .build()
    } else buildRecorder(if (uhd) Quality.UHD else Quality.FHD, if (uhd) 60_000_000 else 24_000_000)

    // Strongest stabilization available: preview stabilization (stabilizes preview + recording,
    // "cinematic"), else video EIS; plus optical stabilization when the lens has OIS.
    // Portrait video always uses the strongest (cinematic) stabilization for smooth footage
    // Stabilization crops the frame; on the front camera that would zoom selfies in, so skip it there
    // True 10-bit HDR bypasses our (8-bit) GPU processing
    val hdr = hdrVideo && !action && !portraitVideo &&
      (try { Recorder.getVideoCapabilities(info).supportedDynamicRanges.any { it != DynamicRange.SDR } } catch (e: Throwable) { false })
    // Horizon lock is for the main cameras (a selfie would just be cropped)
    val horizon = !hdr && !selfieVideo && (action || stabilization == "horizon")
    val wantStab = horizon || (!selfieVideo && (portraitVideo || stabilization != "off"))
    val previewStab = wantStab && (action || horizon || portraitVideo || stabilization == "cinematic") &&
      (try { Preview.getPreviewCapabilities(info).isStabilizationSupported } catch (e: Throwable) { false })
    val videoStabOk = try { Recorder.getVideoCapabilities(info).isStabilizationSupported } catch (e: Throwable) { false }
    val ois = wantStab && oisSupported(info)
    // Our GL effect handles background blur, horizon lock and selfie mirroring; it mirrors the
    // recording itself, so CameraX mirroring is off whenever the effect runs
    // Every SDR recording goes through it for low-light tone, denoise and detail
    val useEffect = !hdr
    // Selfie mirroring is always done by CameraX (it accounts for every device's buffer layout)
    val vb = VideoCapture.Builder(recorder)
      .setMirrorMode(if (mirror) MirrorMode.MIRROR_MODE_ON_FRONT_ONLY else MirrorMode.MIRROR_MODE_OFF)
    if (wantStab && !previewStab && videoStabOk) vb.setVideoStabilizationEnabled(true)

    // Variable frame rate (e.g. 15–30 or 30–60) lets the camera expose longer in dim light instead
    // of going dark; it runs at the full rate whenever there is enough light
    val ranges = info.supportedFrameRateRanges
    val minLow = if (targetFps >= 60) 30 else 15
    (ranges.filter { it.upper == targetFps && it.lower >= minLow && it.lower < targetFps }.minByOrNull { it.lower }
      ?: ranges.firstOrNull { it.lower == targetFps && it.upper == targetFps })
      ?.let { vb.setTargetFrameRate(it) }
      ?: ranges.filter { it.upper >= targetFps }.minByOrNull { it.upper }?.let { vb.setTargetFrameRate(Range(it.upper, it.upper)) }

    if (hdr) {
      val supported = Recorder.getVideoCapabilities(info).supportedDynamicRanges
      if (supported.contains(DynamicRange.HLG_10_BIT)) vb.setDynamicRange(DynamicRange.HLG_10_BIT)
      else if (supported.contains(DynamicRange.HDR_UNSPECIFIED_10_BIT)) vb.setDynamicRange(DynamicRange.HDR_UNSPECIFIED_10_BIT)
    }
    val vc = vb.build()
    if (useEffect) {
      // GPU effect on preview + recording: background blur, horizon lock, mirroring
      try {
        val proc = portraitProcessor ?: PortraitProcessor().also { portraitProcessor = it }
        proc.strength = bokeh
        proc.blurEnabled = portraitVideo
        proc.enhance = true
        proc.filter = if (filterActive(filterParams)) filterParams else null
        proc.smoothing = faceSmoothing
        effectPreview = true
        proc.horizonLock = horizon
        proc.frontCamera = selfieVideo
        proc.mirrorVideo = false
        // Second-stage (image-based) stabilization on top of the phone's own: crop margin by mode
        proc.stabCrop = when {
          stabilization == "off" && !action -> 1f
          selfieVideo -> 1.06f
          action -> 1.16f
          stabilization == "standard" -> 1.08f
          else -> 1.12f
        }
        proc.onWeakGpu = { reason -> post { emitPortraitStatus(mapOf("blur" to false, "reason" to reason)) } }
        val group = UseCaseGroup.Builder()
          .addUseCase(newPreview(previewStab, ois))
          .addUseCase(vc)
          .addEffect(PortraitVideoEffect(proc))
          .build()
        camera = p.bindToLifecycle(owner, sel, group)
        proc.fixedRotation = ((camera?.cameraInfo?.sensorRotationDegrees ?: -90) / 90).let { if (it < 0) -1 else it % 4 }
        videoCapture = vc
        // Horizon lock crops only as much as the current tilt needs, so normal framing is kept
        setRollSensor(horizon)
        return
      } catch (e: Throwable) {
        p.unbindAll()
        if (portraitVideo) emitError("Background blur isn't supported here – recording without it")
      }
    }
    setRollSensor(false)
    // Plain path (effect not used or failed): CameraX does the selfie mirroring
    val plainVc = if (useEffect) {
      VideoCapture.Builder(recorder)
        .setMirrorMode(if (mirror) MirrorMode.MIRROR_MODE_ON_FRONT_ONLY else MirrorMode.MIRROR_MODE_OFF)
        .also { if (wantStab && !previewStab && videoStabOk) it.setVideoStabilizationEnabled(true) }
        .build()
    } else vc
    camera = try {
      p.bindToLifecycle(owner, sel, newPreview(previewStab, ois), plainVc).also { videoCapture = plainVc }
    } catch (e: Throwable) {
      // Fall back to a plain configuration the device is guaranteed to support
      p.unbindAll()
      val plain = VideoCapture.Builder(buildRecorder(Quality.FHD, 20_000_000))
        .setMirrorMode(if (mirror) MirrorMode.MIRROR_MODE_ON_FRONT_ONLY else MirrorMode.MIRROR_MODE_OFF)
        .build()
      p.bindToLifecycle(owner, sel, newPreview(), plain).also { videoCapture = plain }
    }
  }

  /** Macro: the tele-macro or dedicated macro camera found from lens data, with close-focus AF. */
  @OptIn(ExperimentalCamera2Interop::class)
  @androidx.annotation.OptIn(markerClass = [ExperimentalCamera2Interop::class])
  private fun bindMacro(p: ProcessCameraProvider, owner: LifecycleOwner) {
    val m = MacroFinder.find(context) ?: throw IllegalStateException("This phone has no macro camera")
    val targetId = m.parentId ?: m.id
    val sel = CameraSelector.Builder()
      .addCameraFilter { infos -> infos.filter { Camera2CameraInfo.from(it).cameraId == targetId } }
      .build()
    fun <T> macroOpts(b: androidx.camera.core.ExtendableBuilder<T>) {
      val ext = androidx.camera.camera2.interop.Camera2Interop.Extender(b)
      if (m.parentId != null) ext.setPhysicalCameraId(m.id)
      ext.setCaptureRequestOption(CaptureRequest.CONTROL_AF_MODE, CaptureRequest.CONTROL_AF_MODE_CONTINUOUS_PICTURE)
    }
    val pb = Preview.Builder().setResolutionSelector(resolutionSelector())
    macroOpts(pb)
    val ib = ImageCapture.Builder()
      .setResolutionSelector(resolutionSelector())
      .setCaptureMode(ImageCapture.CAPTURE_MODE_MAXIMIZE_QUALITY)
      .setJpegQuality(100)
      .setFlashMode(flashMode())
    macroOpts(ib)
    val preview = pb.build().also {
      it.setSurfaceProvider(previewView.surfaceProvider)
      currentPreview = it
    }
    val ic = ib.build()
    camera = try {
      p.bindToLifecycle(owner, sel, preview, ic)
    } catch (e: Throwable) {
      // Physical-lens streaming refused: fall back to the logical camera zoomed to that lens
      p.unbindAll()
      val prev2 = newPreview(matchAspect = true)
      val ic2 = newImageCapture()
      val cam = p.bindToLifecycle(owner, selector("back"), prev2, ic2)
      if (m.kind == "tele") macroZoom = (m.focalEq / 26.0).toFloat()
      camera = cam
      imageCapture = ic2
      emitError("Macro lens isn't directly accessible here; using the closest-focusing lens instead")
      return
    }
    imageCapture = ic
  }

  private fun bindPro(p: ProcessCameraProvider, owner: LifecycleOwner) {
    val sel = selector(facing)
    val ic = ImageCapture.Builder()
      .setResolutionSelector(resolutionSelector())
      .setCaptureMode(ImageCapture.CAPTURE_MODE_MAXIMIZE_QUALITY)
      .setFlashMode(flashMode())
      .build()
    val vc = VideoCapture.Builder(buildRecorder(Quality.UHD, 60_000_000))
      .setMirrorMode(if (mirror) MirrorMode.MIRROR_MODE_ON_FRONT_ONLY else MirrorMode.MIRROR_MODE_OFF)
      .build()
    camera = try {
      p.bindToLifecycle(owner, sel, newPreview(matchAspect = true), ic, vc).also { videoCapture = vc }
    } catch (e: Throwable) {
      p.unbindAll()
      p.bindToLifecycle(owner, sel, newPreview(matchAspect = true), ic)
    }
    imageCapture = ic
  }

  @OptIn(ExperimentalHighSpeedVideo::class, androidx.camera.core.ExperimentalSessionConfig::class)
  @androidx.annotation.OptIn(markerClass = [ExperimentalHighSpeedVideo::class, androidx.camera.core.ExperimentalSessionConfig::class])
  private fun bindSlowMo(p: ProcessCameraProvider, owner: LifecycleOwner) {
    val sel = selector(facing)
    val info = p.getCameraInfo(sel)
    if (Recorder.getHighSpeedVideoCapabilities(info) == null) {
      throw IllegalStateException("Slow motion isn't supported by this camera")
    }
    val vc = VideoCapture.Builder(Recorder.Builder().build())
      .setMirrorMode(if (mirror) MirrorMode.MIRROR_MODE_ON_FRONT_ONLY else MirrorMode.MIRROR_MODE_OFF)
      .build()
    val builder = HighSpeedVideoSessionConfig.Builder(vc)
    builder.setPreview(newPreview())
    builder.setSlowMotionEnabled(true)
    val best = info.getSupportedFrameRateRanges(builder.build()).maxByOrNull { it.upper }
    if (best != null) builder.setFrameRateRange(best)
    slowFps = best?.upper ?: 0
    camera = p.bindToLifecycle(owner, sel, builder.build())
    videoCapture = vc
  }

  private fun bindDual(p: ProcessCameraProvider, owner: LifecycleOwner) {
    val pair = p.availableConcurrentCameraInfos.firstOrNull { list ->
      list.any { it.lensFacing == CameraSelector.LENS_FACING_BACK } &&
        list.any { it.lensFacing == CameraSelector.LENS_FACING_FRONT }
    } ?: throw IllegalStateException("This phone can't run front and back cameras at the same time")

    val back = pair.first { it.lensFacing == CameraSelector.LENS_FACING_BACK }
    val front = pair.first { it.lensFacing == CameraSelector.LENS_FACING_FRONT }
    val main = if (dualPrimary == "front") front else back
    val pip = if (dualPrimary == "front") back else front

    if (!dualComposed) {
      // Preview: two independent streams, the inset is a real view you can drag smoothly
      val mainPrev = newPreview()
      val pipPrev = Preview.Builder().build().also { it.setSurfaceProvider(pipPreview.surfaceProvider) }
      val primaryCfg = ConcurrentCamera.SingleCameraConfig(
        main.cameraSelector, UseCaseGroup.Builder().addUseCase(mainPrev).build(), owner,
      )
      val secondaryCfg = ConcurrentCamera.SingleCameraConfig(
        pip.cameraSelector, UseCaseGroup.Builder().addUseCase(pipPrev).build(), owner,
      )
      val cc = p.bindToLifecycle(listOf(primaryCfg, secondaryCfg))
      camera = cc.cameras.firstOrNull { it.cameraInfo.lensFacing == main.lensFacing } ?: cc.cameras.firstOrNull()
      cc.cameras.firstOrNull { it.cameraInfo.lensFacing == CameraSelector.LENS_FACING_FRONT }?.let { fr ->
        val z = fr.cameraInfo.zoomState.value
        fr.cameraControl.setZoomRatio(1.3f.coerceIn(z?.minZoomRatio ?: 1f, z?.maxZoomRatio ?: 1f))
      }
      videoCapture = null
      pipContainer.visibility = View.VISIBLE
      layoutPip()
      return
    }

    // Mirror mode is applied per camera: only the selfie stream is mirrored in the composed video
    val vc = VideoCapture.Builder(buildRecorder(Quality.FHD, 20_000_000))
      .setMirrorMode(if (mirror) MirrorMode.MIRROR_MODE_ON_FRONT_ONLY else MirrorMode.MIRROR_MODE_OFF)
      .build()
    val group = UseCaseGroup.Builder().addUseCase(newPreview()).addUseCase(vc).build()

    // Picture-in-picture box in normalized device coordinates (origin centre, +y up).
    // Size it to the inset camera's own 3:4 portrait shape so faces aren't stretched.
    // The composited stream is 3:4 portrait; the full-screen preview centre-crops its sides.
    // Convert screen-space position/size (what the user drags) into the stream's NDC.
    val viewAspect = if (height > 0) width.toFloat() / height else 9f / 20f
    val outAspect = 3f / 4f
    val visX = (viewAspect / outAspect).coerceAtMost(1f) // share of stream width that is on screen
    val visY = (outAspect / viewAspect).coerceAtMost(1f)
    val sx = (pipSize * visX).coerceIn(0.1f, 0.8f)
    // Inset keeps the selfie stream's own 3:4 shape: h_px/w_px = 4/3 → sy = sx * outAspect * 4/3
    val sy = (sx * outAspect * (4f / 3f)).coerceAtMost(0.9f)
    val cx = ((pipX * 2f - 1f) * visX).coerceIn(-visX + sx, visX - sx)
    val cy = ((1f - pipY * 2f) * visY).coerceIn(-visY + sy, visY - sy)

    val primary = ConcurrentCamera.SingleCameraConfig(
      main.cameraSelector,
      group,
      CompositionSettings.Builder().setAlpha(1f).setOffset(0f, 0f).setScale(1f, 1f).build(),
      owner,
    )
    val secondary = ConcurrentCamera.SingleCameraConfig(
      pip.cameraSelector,
      group,
      CompositionSettings.Builder().setAlpha(1f).setOffset(cx, cy).setScale(sx, sy).build(),
      owner,
    )
    val cc = p.bindToLifecycle(listOf(primary, secondary))
    camera = cc.cameras.firstOrNull { it.cameraInfo.lensFacing == main.lensFacing } ?: cc.cameras.firstOrNull()
    // Selfie lenses are very wide: zoom in a little so the face fills and centres in its window
    cc.cameras.firstOrNull { it.cameraInfo.lensFacing == CameraSelector.LENS_FACING_FRONT }?.let { front ->
      val z = front.cameraInfo.zoomState.value
      val target = 1.3f.coerceIn(z?.minZoomRatio ?: 1f, z?.maxZoomRatio ?: 1f)
      front.cameraControl.setZoomRatio(target)
    }
    videoCapture = vc
  }

  /* ---------------- manual controls ---------------- */

  @OptIn(ExperimentalCamera2Interop::class)
  @androidx.annotation.OptIn(markerClass = [ExperimentalCamera2Interop::class])
  private fun applyControls() {
    val cam = camera ?: return
    try {
      // Camera2 overrides only in Pro; other modes stay fully automatic so the vendor 3A runs normally
      if (mode == "pro") {
        val b = CaptureRequestOptions.Builder()
        val manualExposure = iso > 0 && shutterNs > 0
        if (manualExposure) {
          b.setCaptureRequestOption(CaptureRequest.CONTROL_AE_MODE, CaptureRequest.CONTROL_AE_MODE_OFF)
          b.setCaptureRequestOption(CaptureRequest.SENSOR_SENSITIVITY, iso)
          b.setCaptureRequestOption(CaptureRequest.SENSOR_EXPOSURE_TIME, shutterNs)
          b.setCaptureRequestOption(CaptureRequest.SENSOR_FRAME_DURATION, max(shutterNs, 33_333_333L))
        }
        if (wb == "kelvin") {
          b.setCaptureRequestOption(CaptureRequest.CONTROL_AWB_MODE, CaptureRequest.CONTROL_AWB_MODE_OFF)
          b.setCaptureRequestOption(CaptureRequest.COLOR_CORRECTION_MODE, CaptureRequest.COLOR_CORRECTION_MODE_TRANSFORM_MATRIX)
          b.setCaptureRequestOption(CaptureRequest.COLOR_CORRECTION_GAINS, kelvinToGains(kelvin))
        } else if (wb != "auto") {
          b.setCaptureRequestOption(
            CaptureRequest.CONTROL_AWB_MODE,
            when (wb) {
              "daylight" -> CaptureRequest.CONTROL_AWB_MODE_DAYLIGHT
              "cloudy" -> CaptureRequest.CONTROL_AWB_MODE_CLOUDY_DAYLIGHT
              "shade" -> CaptureRequest.CONTROL_AWB_MODE_SHADE
              "tungsten" -> CaptureRequest.CONTROL_AWB_MODE_INCANDESCENT
              "fluorescent" -> CaptureRequest.CONTROL_AWB_MODE_FLUORESCENT
              "twilight" -> CaptureRequest.CONTROL_AWB_MODE_TWILIGHT
              else -> CaptureRequest.CONTROL_AWB_MODE_AUTO
            },
          )
        }
        if (focus >= 0f) {
          b.setCaptureRequestOption(CaptureRequest.CONTROL_AF_MODE, CaptureRequest.CONTROL_AF_MODE_OFF)
          b.setCaptureRequestOption(CaptureRequest.LENS_FOCUS_DISTANCE, focus)
        }
        Camera2CameraControl.from(cam.cameraControl).setCaptureRequestOptions(b.build())
        if (manualExposure) return
      } else if (!usingNightExtension) {
        Camera2CameraControl.from(cam.cameraControl).clearCaptureRequestOptions()
      }
      setEvIndex(ev + burstEvOffset)
    } catch (e: Throwable) {
      emitError("Camera control rejected: ${e.message}")
    }
  }

  private fun setEvIndex(target: Double) {
    val cam = camera ?: return
    val state = cam.cameraInfo.exposureState
    if (!state.isExposureCompensationSupported) return
    val step = state.exposureCompensationStep.toDouble()
    if (step <= 0) return
    val idx = (target / step).roundToInt()
      .coerceIn(state.exposureCompensationRange.lower, state.exposureCompensationRange.upper)
    cam.cameraControl.setExposureCompensationIndex(idx)
  }

  /** Colour temperature → RGGB gains (Tanner Helland's blackbody fit, scaled to typical sensor gains). */
  private fun kelvinToGains(k: Int): RggbChannelVector {
    val t = k.coerceIn(2000, 10000) / 100.0
    val r = if (t <= 66) 255.0 else 329.698727446 * (t - 60).pow(-0.1332047592)
    val g = if (t <= 66) 99.4708025861 * ln(t) - 161.1195681661 else 288.1221695283 * (t - 60).pow(-0.0755148492)
    val bl = when {
      t >= 66 -> 255.0
      t <= 19 -> 1.0
      else -> 138.5177312231 * ln(t - 10) - 305.0447927307
    }
    val rr = r.coerceIn(1.0, 255.0)
    val gg = g.coerceIn(1.0, 255.0)
    val bb = bl.coerceIn(1.0, 255.0)
    return RggbChannelVector(
      (2.0 * gg / rr).toFloat().coerceIn(0.5f, 6f),
      1f,
      1f,
      (1.6 * gg / bb).toFloat().coerceIn(0.5f, 6f),
    )
  }

  fun focusAt(xDp: Float, yDp: Float) {
    val cam = camera ?: return
    val d = resources.displayMetrics.density
    val point = previewView.meteringPointFactory.createPoint(xDp * d, yDp * d)
    try {
      cam.cameraControl.startFocusAndMetering(FocusMeteringAction.Builder(point).build())
    } catch (_: Throwable) {}
  }

  /* ---------------- capture ---------------- */

  /**
   * Captures [count] frames back to back. A non-zero [evShift] temporarily biases exposure first
   * (HDR+ shoots under-exposed bursts). Emits onPhotosCaptured with every saved path.
   */
  fun captureBurst(count: Int, evShift: Double, shortEv: Double) {
    val ic = imageCapture ?: run { emitError("Photos aren't available in this mode"); return }
    val n = count.coerceIn(1, 8)
    val withShort = shortEv < 0 && n > 1 && !usingNightExtension && mode != "pro"
    val paths = ArrayList<String>()
    val evs = ArrayList<Double>()
    val metas = ArrayList<Map<String, Any>>()
    var failures = 0
    val firstFlash = ic.flashMode

    fun currentEv(): Double {
      val st = camera?.cameraInfo?.exposureState ?: return 0.0
      return st.exposureCompensationIndex * st.exposureCompensationStep.toDouble()
    }

    fun finish(error: String?) {
      burstEvOffset = 0.0
      ic.flashMode = firstFlash
      applyControls()
      emitPhotosCaptured(
        mapOf("paths" to paths, "evs" to evs, "meta" to metas,
          "shortIndex" to if (withShort && paths.size >= 2 && evs.last() < evs.first() - 0.5) paths.size - 1 else -1,
          "error" to error, "nightExtension" to usingNightExtension),
      )
    }

    // Snapshot of what the preview shows (mirrored for selfies), to check whether this phone's
    // camera already mirrors its front-camera JPEGs
    val previewShot: android.graphics.Bitmap? = if (facing == "front") try { previewView.bitmap } catch (e: Throwable) { null } else null
    val fitMode = previewFit

    fun shoot(i: Int) {
      val file = File(context.cacheDir, "iCam_${System.currentTimeMillis()}_$i.jpg")
      // Mirroring is applied when the photo is processed (works the same with every capture path)
      val meta = ImageCapture.Metadata()
      if (i == 0) playSound(android.media.MediaActionSound.SHUTTER_CLICK)
      if (i > 0) ic.flashMode = ImageCapture.FLASH_MODE_OFF
      val ev = currentEv()
      ic.takePicture(
        ImageCapture.OutputFileOptions.Builder(file).setMetadata(meta).build(),
        executor,
        object : ImageCapture.OnImageSavedCallback {
          override fun onImageSaved(output: ImageCapture.OutputFileResults) {
            paths.add(file.absolutePath)
            evs.add(ev)
            metas.add(photoMeta(file, if (i == 0) previewShot else null, fitMode))
            when {
              i + 1 < n -> postDelayed({ shoot(i + 1) }, 40)
              i + 1 == n && withShort -> {
                // One darker frame to recover bright windows / sky / lamps
                burstEvOffset = evShift + shortEv
                applyControls()
                postDelayed({ shoot(i + 1) }, 300)
              }
              else -> finish(null)
            }
          }

          override fun onError(exception: ImageCaptureException) {
            // Keep the burst going if a single frame fails
            failures++
            if (paths.isEmpty() && failures >= 3) {
              finish(exception.message ?: "Capture failed")
            } else if (i + 1 < n && failures < 3) {
              postDelayed({ shoot(i + 1) }, 80)
            } else {
              finish(if (paths.isEmpty()) exception.message ?: "Capture failed" else null)
            }
          }
        },
      )
    }

    if (n > 1 && evShift != 0.0 && !usingNightExtension && mode != "pro") {
      burstEvOffset = evShift
      applyControls()
      postDelayed({ shoot(0) }, 320)
    } else {
      shoot(0)
    }
  }

  /** EXIF orientation + raw (stored) pixel size, so JS can rotate/mirror correctly. */
  private fun photoMeta(file: File, preview: android.graphics.Bitmap? = null, fit: Boolean = false): Map<String, Any> {
    val o = try {
      android.media.ExifInterface(file.absolutePath)
        .getAttributeInt(android.media.ExifInterface.TAG_ORIENTATION, android.media.ExifInterface.ORIENTATION_NORMAL)
    } catch (e: Throwable) { 1 }
    val b = android.graphics.BitmapFactory.Options().apply { inJustDecodeBounds = true }
    android.graphics.BitmapFactory.decodeFile(file.absolutePath, b)
    val m = mutableMapOf<String, Any>("orientation" to o, "width" to b.outWidth, "height" to b.outHeight)
    if (preview != null) {
      // -1 unknown, 0 = JPEG is the true view (normal), 1 = the phone already mirrored it
      m["jpegMirrored"] = try { MirrorCheck.jpegMirrored(file, o, b.outWidth, b.outHeight, preview, fit) } catch (e: Throwable) { -1 }
    }
    return m
  }

  @SuppressLint("MissingPermission")
  fun startRecording() {
    if (mode == "dual" && !dualComposed) {
      dualComposed = true
      pendingDualRecord = true
      scheduleRebind()
      return
    }
    val vc = videoCapture ?: run { emitError("Video isn't available in this mode"); return }
    if (recording != null) return
    val file = File(context.cacheDir, "iCam_${mode}_${System.currentTimeMillis()}.mp4")
    var pending = vc.output.prepareRecording(context, FileOutputOptions.Builder(file).build())
    val micGranted = ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) ==
      PackageManager.PERMISSION_GRANTED
    if (audio && micGranted && mode != "slowmo") pending = pending.withAudioEnabled()
    // Persistent: survives re-binding to the other camera (front/back switch while recording)
    persistentRec = false
    if (mode == "video" || mode == "action") {
      try { pending = makePersistent(pending); persistentRec = true } catch (_: Throwable) {}
    }
    // Keep the timeline continuous if the camera is switched mid-recording
    portraitProcessor?.let { it.resetTimeline(); it.holdTimeline = true }
    playSound(android.media.MediaActionSound.START_VIDEO_RECORDING)
    // Keep the display awake for the whole recording
    palm.setEnabled(false)
    keepScreenOn = true
    rootView?.keepScreenOn = true
    recording = pending.start(executor) { event ->
      if (event is VideoRecordEvent.Pause) emitRecordingState(mapOf("paused" to true))
      if (event is VideoRecordEvent.Resume) emitRecordingState(mapOf("paused" to false))
      if (event is VideoRecordEvent.Finalize) {
        recording = null
        persistentRec = false
        keepScreenOn = false
        rootView?.keepScreenOn = false
        portraitProcessor?.let { it.holdTimeline = false; it.resetTimeline() }
        playSound(android.media.MediaActionSound.STOP_VIDEO_RECORDING)
        post { updateGestures() }
        val ok = file.exists() && file.length() > 0
        emitRecordingFinished(
          mapOf(
            "path" to if (ok) file.absolutePath else null,
            "durationMs" to event.recordingStats.recordedDurationNanos / 1_000_000.0,
            "slowMotion" to (mode == "slowmo"),
            "error" to if (event.hasError()) "Recorder error ${event.error}" else null,
          ),
        )
        if (mode == "dual" && dualComposed) {
          dualComposed = false
          scheduleRebind(150)
        }
      }
    }
  }

  fun stopRecording() {
    recording?.stop()
  }

  private var persistentRec = false

  @OptIn(ExperimentalPersistentRecording::class)
  @androidx.annotation.OptIn(markerClass = [ExperimentalPersistentRecording::class])
  private fun makePersistent(p: androidx.camera.video.PendingRecording) = p.asPersistentRecording()

  fun pauseRecording() { recording?.pause() }
  fun resumeRecording() { recording?.resume() }

  private fun emitError(message: String) {
    emitError(mapOf("message" to message))
  }
}
