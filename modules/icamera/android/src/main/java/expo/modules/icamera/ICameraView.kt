package expo.modules.icamera

import android.Manifest
import android.annotation.SuppressLint
import android.content.Context
import android.content.pm.PackageManager
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
    /** iCam's own recorder (needed only for front/back switching mid-recording) — off by request. */
    private const val USE_OWN_RECORDER = false
    private val PHOTO_MODES = setOf("photo", "portrait", "night", "pro", "macro")
  }

  private val previewView = PreviewView(context).apply {
    implementationMode = PreviewView.ImplementationMode.COMPATIBLE
    scaleType = PreviewView.ScaleType.FIT_CENTER
    layoutParams = ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
  }
  private val executor = ContextCompat.getMainExecutor(context)

  private var provider: ProcessCameraProvider? = null
  private var extensions: ExtensionsManager? = null
  private var camera: Camera? = null
  private var imageCapture: ImageCapture? = null
  private var videoCapture: VideoCapture<Recorder>? = null
  @Volatile private var videoHardwareStabilized = false
  @Volatile private var stabilityEpoch = 0
  @Volatile private var requestedSharedStability = false
  private var sharedOffSamples = 0
  @Volatile private var sharedFallbackApplied = false
  private var recording: Recording? = null
  private var slowFps = 0
  private var usingNightExtension = false // true whenever a vendor extension handles processing
  private var activeExtension: String? = null

  // Props
  private var mode = "photo"
  private var facing = "back"
  private var dualPrimary = "back"
  private var zoom = 1f
  private var defaultFrontFallback = false
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
  private var boundFrameRate = 30
  private var manualControls = false
  fun setManualControls(v: Boolean) { manualControls = v; applyControls() }
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
  @Volatile private var joiningVideo = false
  private fun emitRecordingFinished(m: Map<String, Any?>) { joiningVideo=false; onRecordingFinished(clean(m)) }
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
    scaleType = PreviewView.ScaleType.FIT_CENTER
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
  fun setFacing(v: String) = rebindOnChange(facing, v) { facing = it; zoom = 1f; defaultFrontFallback = false }
  fun setDualPrimary(v: String) = rebindOnChange(dualPrimary, v) { dualPrimary = it; zoom = 1f }
  fun setMirror(v: Boolean) = rebindOnChange(mirror, v) { mirror = it }
  fun setActive(v: Boolean) = rebindOnChange(active, v) {
    active=it
    if(!it){cancelPendingStart();stopAfterSwitch=true;recording?.stop();if(ownRec!=null)stopOwnRecording()}
    post { updateGestures() }
  }
  fun setVideoQuality(v: String) = rebindOnChange(videoQuality, v) { videoQuality = it }
  fun setFps(v: Int) = rebindOnChange(fps, v) { fps = it }
  fun setHdrVideo(v: Boolean) = rebindOnChange(hdrVideo, v) { hdrVideo = it }
  private var antibanding = "country"
  fun setAntibanding(v: String) = rebindOnChange(antibanding, v) { antibanding = it }
  fun setStabilization(v: String) = rebindOnChange(stabilization, if(v in listOf("off","standard","cinematic")) v else "cinematic") { stabilization = it }
  fun setNightExtension(v: Boolean) = rebindOnChange(nightExtension, v) { nightExtension = it }
  fun setAudio(v: Boolean) { audio = v }
  fun setAspect(v: String) = rebindOnChange(aspect, v) { aspect = it }
  /**
   * Video / Action aperture: f-number to use (0 = automatic). Lenses with a real variable aperture
   * get it set directly; on fixed-aperture lenses it's simulated with depth blur (lower f = more blur).
   */
  private var aperture = 0f
  fun setAperture(v: Float) {
    aperture = v
    applyAperture()
  }

  @OptIn(ExperimentalCamera2Interop::class)
  @androidx.annotation.OptIn(markerClass = [ExperimentalCamera2Interop::class])
  private fun applyAperture() {
    val videoish = mode == "video" || mode == "action"
    val cam = camera
    val real = cam?.let {
      try {
        Camera2CameraInfo.from(it.cameraInfo)
          .getCameraCharacteristic(android.hardware.camera2.CameraCharacteristics.LENS_INFO_AVAILABLE_APERTURES)
      } catch (e: Throwable) { null }
    }
    val proc = portraitProcessor
    if (videoish && real != null && real.size > 1) {
      // physical aperture: nearest supported f-number (automatic = widest)
      val f = if (aperture > 0f) real.minByOrNull { Math.abs(it - aperture) }!! else real.minOrNull()!!
      try {
        androidx.camera.camera2.interop.Camera2CameraControl.from(cam.cameraControl).addCaptureRequestOptions(
          androidx.camera.camera2.interop.CaptureRequestOptions.Builder()
            .setCaptureRequestOption(CaptureRequest.LENS_APERTURE, f)
            .build(),
        )
      } catch (_: Throwable) {}
      proc?.blurEnabled = false
      return
    }
    if (videoish && proc != null) {
      // simulated depth of field: f/1.4 strong … f/4 light background blur
      if (aperture > 0f) {
        proc.strength = (1.25f - aperture * 0.25f).coerceIn(0.15f, 1f)
        proc.blurEnabled = true
      } else {
        proc.blurEnabled = false
        proc.strength = bokeh
      }
    }
  }

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
    val live = active && isAttachedToWindow && recording == null && ownRec == null
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

  private var rearSelfie = false
  fun setRearSelfie(v: Boolean) = rebindOnChange(rearSelfie,v){rearSelfie=it}

  fun setPreviewFit(v: Boolean) {
    previewFit = v
    previewView.scaleType = if(previewFit) PreviewView.ScaleType.FIT_CENTER else PreviewView.ScaleType.FILL_CENTER
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


  /** True while the GPU effect renders the preview (video modes, or a live filter in photo modes). */
  @Volatile private var effectPreview = false
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
    val front = (if (mode == "dual") dualPrimary == "front" else facing == "front")
    var hw = PhoneCameraPolicy.hardwareZoom(front, macroZoom ?: zoom, zMin, zMax)
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
    digitalZoom = if (mode == "dual" || mode == "slowmo") 1f else PhoneCameraPolicy.digitalZoom(front, zoom, zMin, zMax)
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
    val sx = if(mainFront){if(!mirror && !rearSelfie)-s else s}else if(rearSelfie)-s else s
    // mirror flips apply instantly; zoom changes glide
    if (Math.signum(previewView.scaleX) != Math.signum(sx)) { previewView.animate().cancel(); previewView.scaleX = sx; previewView.scaleY = s }
    else previewView.animate().scaleX(sx).scaleY(s).setDuration(180).start()
    val pipFront = mode == "dual" && dualPrimary != "front"
    pipPreview.scaleX = if (pipFront && !mirror) -1f else 1f
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
    try { if (orientationListener.canDetectOrientation()) orientationListener.enable() } catch (_: Throwable) {}
    scheduleRebind(150)
  }

  override fun onDetachedFromWindow() {
    super.onDetachedFromWindow()
    try { orientationListener.disable() } catch (_: Throwable) {}
    cancelPendingStart();stopAfterSwitch=true
    recording?.stop()
    recording = null
    if (ownRec != null) stopOwnRecording()
    if(!RearDisplayRouter.isMoving)provider?.unbindAll()
    r…14689 tokens truncated…o 0.0, "slowMotion" to false, "error" to "Nothing was recorded"))
      return
    }
    if (parts.size == 1) {
      finishJoinedVideo(parts[0],dur)
      return
    }
    joiningVideo=true
    emitRecordingState(mapOf("merging" to true))
    val durs0 = ArrayList(segmentDurUs)
    segmentDurUs.clear()
    val rot = sessionRotation
    // Fast path: copy the pieces' video as-is (no re-encode) and only re-encode the sound with fades
    Thread({
      val fastOut = File(context.cacheDir, "iCam_video_${System.currentTimeMillis()}.mp4")
      val ok = try { FastJoin.join(parts, fastOut) } catch (e: Throwable) { false }
      post {
        if (ok && RecordedClip.hasVideoSample(fastOut)) {
          parts.forEach { try { it.delete() } catch (_: Throwable) {} }
          finishJoinedVideo(fastOut,dur)
        } else {
          transformJoin(parts, durs0, dur, rot)
        }
      }
    }, "iCamJoin").start()
  }

  @androidx.annotation.OptIn(markerClass = [androidx.media3.common.util.UnstableApi::class])
  private fun finishJoinedVideo(file: File, durationMs: Double) {
    emitRecordingFinished(mapOf("path" to file.absolutePath,"durationMs" to durationMs,"slowMotion" to false))
  }

  /** Full join (decode → effects → encode); used when the pieces can't simply be copied together. */
  private fun transformJoin(parts: List<File>, durs: List<Long>, dur: Double, sessionRotation: Int) {
    val portrait = sessionRotation == android.view.Surface.ROTATION_0 || sessionRotation == android.view.Surface.ROTATION_180
    val w = if (portrait) 1080 else 1920
    val h = if (portrait) 1920 else 1080
    val out = File(context.cacheDir, "iCam_video_${System.currentTimeMillis()}.mp4")
    try {
      val present = androidx.media3.effect.Presentation.createForWidthAndHeight(w, h, androidx.media3.effect.Presentation.LAYOUT_SCALE_TO_FIT_WITH_CROP)
      val items = parts.mapIndexed { i, f ->
        val first = i == 0
        val last = i == parts.size - 1
        // Pieces after the first lose their first ~0.1 s (the camera settling its exposure)
        val trimUs = if (first) 0L else 100_000L
        val durUs = maxOf(0L, (durs.getOrNull(i) ?: 0L) - trimUs)
        val mi = androidx.media3.common.MediaItem.Builder()
          .setUri(android.net.Uri.fromFile(f))
          .setClippingConfiguration(
            androidx.media3.common.MediaItem.ClippingConfiguration.Builder().setStartPositionMs(trimUs / 1000).build(),
          )
          .build()
        // Fade the sound and dip the picture at each join (not at the very start or end)
        val fadeIn = if (first) 0L else 120_000L
        val fadeOut = if (last) 0L else 120_000L
        val audio = listOf<androidx.media3.common.audio.AudioProcessor>(EdgeFadeAudioProcessor(fadeIn, fadeOut, durUs))
        val video = listOf<androidx.media3.common.Effect>(
          present,
          EdgeDip(durUs, if (first) 0L else 150_000L, if (last) 0L else 150_000L),
        )
        androidx.media3.transformer.EditedMediaItem.Builder(mi)
          .setEffects(androidx.media3.transformer.Effects(audio, video))
          .build()
      }
      val composition = androidx.media3.transformer.Composition.Builder(listOf(androidx.media3.transformer.EditedMediaItemSequence(items))).build()
      val transformer = androidx.media3.transformer.Transformer.Builder(context)
        .setVideoMimeType(androidx.media3.common.MimeTypes.VIDEO_H264)
        .setAudioMimeType(androidx.media3.common.MimeTypes.AUDIO_AAC)
        .addListener(object : androidx.media3.transformer.Transformer.Listener {
          override fun onCompleted(c: androidx.media3.transformer.Composition, r: androidx.media3.transformer.ExportResult) {
            if(RecordedClip.hasVideoSample(out)){
              parts.forEach { try { it.delete() } catch (_: Throwable) {} }
              finishJoinedVideo(out,dur)
            }else emitRecordingFinished(mapOf("path" to parts[0].absolutePath,"durationMs" to dur,"slowMotion" to false,
              "extraPaths" to parts.drop(1).map{it.absolutePath},"error" to "Joined output had no video frames; saved the original clips"))
          }
          override fun onError(c: androidx.media3.transformer.Composition, r: androidx.media3.transformer.ExportResult, e: androidx.media3.transformer.ExportException) {
            // Couldn't join: keep every piece (each is a valid video) rather than lose anything
            emitRecordingFinished(mapOf(
              "path" to parts[0].absolutePath, "durationMs" to dur, "slowMotion" to false,
              "extraPaths" to parts.drop(1).map { it.absolutePath },
              "error" to "Couldn't join the clips (${e.errorCodeName}); saved them separately",
            ))
          }
        })
        .build()
      transformer.start(composition, out.absolutePath)
    } catch (e: Throwable) {
      emitRecordingFinished(mapOf(
        "path" to parts[0].absolutePath, "durationMs" to dur, "slowMotion" to false,
        "extraPaths" to parts.drop(1).map { it.absolutePath },
        "error" to "Couldn't join the clips; saved them separately",
      ))
    }
  }

  @OptIn(ExperimentalPersistentRecording::class)
  @androidx.annotation.OptIn(markerClass = [ExperimentalPersistentRecording::class])
  private fun makePersistent(p: androidx.camera.video.PendingRecording) = p.asPersistentRecording()

  fun pauseRecording() {
    ownRec?.let { it.pause(); emitRecordingState(mapOf("paused" to true)); return }
    recording?.pause()
  }
  fun resumeRecording() {
    ownRec?.let { it.resume(); emitRecordingState(mapOf("paused" to false)); return }
    recording?.resume()
  }

  private fun emitError(message: String) {
    emitError(mapOf("message" to message))
  }
}
