package expo.modules.icamera

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Matrix
import android.graphics.SurfaceTexture
import android.hardware.camera2.CameraCaptureSession
import android.hardware.camera2.CameraCharacteristics
import android.hardware.camera2.CameraDevice
import android.hardware.camera2.CameraManager
import android.hardware.camera2.CaptureRequest
import android.media.MediaCodec
import android.media.MediaCodecList
import android.media.MediaFormat
import android.media.MediaRecorder
import android.os.Build
import android.os.Handler
import android.os.HandlerThread
import android.util.Range
import android.util.Size
import android.view.Surface
import android.view.TextureView
import java.io.File

/** What one camera offers other apps for recording (from its own stream configuration). */
internal data class LensVideo(val id: String, val front: Boolean, val sizes: List<Size>) {
  val best16x9: Size? get() = sizes.filter { it.width * 9 == it.height * 16 }.maxByOrNull { it.width.toLong() * it.height }
  fun describe() = "camera $id (${if (front) "front" else "back"}): ${best16x9?.let { "${it.width}×${it.height}" } ?: "no 16:9 video"}"
}

/** Scans every camera the phone lists for its real recording sizes. */
internal object LensScan {
  fun all(context: Context): List<LensVideo> {
    val manager = context.getSystemService(Context.CAMERA_SERVICE) as CameraManager
    val ids = LinkedHashSet<String>().apply { addAll(manager.cameraIdList) }
    // Some phones open more ids than they list; probe a few without failing.
    for (i in 0..9) ids.add(i.toString())
    return ids.mapNotNull { id ->
      try {
        val ch = manager.getCameraCharacteristics(id)
        val map = ch.get(CameraCharacteristics.SCALER_STREAM_CONFIGURATION_MAP) ?: return@mapNotNull null
        val sizes = map.getOutputSizes(MediaRecorder::class.java)?.toList().orEmpty()
        LensVideo(id, ch.get(CameraCharacteristics.LENS_FACING) == CameraCharacteristics.LENS_FACING_FRONT, sizes)
      } catch (_: Exception) { null }
    }
  }
  /** The largest 16:9 recording size up to [maxWidth] on [preferredId], or another lens facing the same way. */
  fun pick(context: Context, preferredId: String, front: Boolean, maxWidth: Int): Pair<String, Size>? {
    val lenses = all(context)
    fun fit(l: LensVideo) = l.sizes.filter { it.width * 9 == it.height * 16 && it.width <= maxWidth }.maxByOrNull { it.width.toLong() * it.height }
    lenses.firstOrNull { it.id == preferredId }?.let { l -> fit(l)?.takeIf { it.width >= 3840 }?.let { return l.id to it } }
    return lenses.filter { it.front == front }.mapNotNull { l -> fit(l)?.let { l.id to it } }
      .filter { it.second.width >= 3840 }.maxByOrNull { it.second.width }
  }
}

/**
 * 4K video straight from Camera2 with a hardware MediaRecorder. Used when the camera library's own
 * capability checks cap the phone below its real recording size. Preview goes to a TextureView;
 * the recorder's persistent surface is only fed while recording.
 */
internal class DirectVideo(
  private val context: Context,
  private val texture: TextureView,
  val cameraId: String,
  val size: Size,
  private val fps: Int,
  private val bitrate: Int,
  private val onError: (String) -> Unit,
) {
  private val thread = HandlerThread("iCamDirectVideo").apply { start() }
  private val handler = Handler(thread.looper)
  private val manager = context.getSystemService(Context.CAMERA_SERVICE) as CameraManager
  private val chars = manager.getCameraCharacteristics(cameraId)
  val front = chars.get(CameraCharacteristics.LENS_FACING) == CameraCharacteristics.LENS_FACING_FRONT
  private val sensor = chars.get(CameraCharacteristics.SENSOR_ORIENTATION) ?: 90
  val zoomRange: Range<Float> = if (Build.VERSION.SDK_INT >= 30) chars.get(CameraCharacteristics.CONTROL_ZOOM_RATIO_RANGE) ?: Range(1f, 1f) else Range(1f, 1f)
  private val persistent: Surface = MediaCodec.createPersistentInputSurface()
  private var device: CameraDevice? = null
  private var session: CameraCaptureSession? = null
  private var previewSurface: Surface? = null
  private var recorder: MediaRecorder? = null
  private var file: File? = null
  private var startedAt = 0L
  private var pausedMs = 0L
  private var pausedAt = 0L
  @Volatile var zoom = 1f
  @Volatile var evIndex = 0
  @Volatile private var closed = false
  val recording get() = recorder != null

  private val hevc: Boolean = try {
    MediaCodecList(MediaCodecList.REGULAR_CODECS).codecInfos.any { info ->
      info.isEncoder && info.supportedTypes.any { it.equals(MediaFormat.MIMETYPE_VIDEO_HEVC, true) } &&
        info.getCapabilitiesForType(MediaFormat.MIMETYPE_VIDEO_HEVC).videoCapabilities.isSizeSupported(size.width, size.height)
    }
  } catch (_: Throwable) { false }

  fun open() {
    if (texture.isAvailable) start(texture.surfaceTexture!!)
    else texture.surfaceTextureListener = object : TextureView.SurfaceTextureListener {
      override fun onSurfaceTextureAvailable(st: SurfaceTexture, w: Int, h: Int) { start(st) }
      override fun onSurfaceTextureSizeChanged(st: SurfaceTexture, w: Int, h: Int) { fitPreview() }
      override fun onSurfaceTextureDestroyed(st: SurfaceTexture) = true
      override fun onSurfaceTextureUpdated(st: SurfaceTexture) {}
    }
  }

  private fun previewSize(): Size {
    val map = chars.get(CameraCharacteristics.SCALER_STREAM_CONFIGURATION_MAP)
    val sizes = map?.getOutputSizes(SurfaceTexture::class.java)?.filter { it.width * 9 == it.height * 16 && it.width <= 1920 }
    return sizes?.maxByOrNull { it.width } ?: Size(1920, 1080)
  }

  /** Centre-crop the upright preview into the view, like the regular viewfinder. */
  fun fitPreview() {
    val p = previewSize()
    val w = texture.width.toFloat(); val h = texture.height.toFloat()
    if (w <= 0 || h <= 0) return
    val sideways = sensor % 180 != 0
    val cw = if (sideways) p.height.toFloat() else p.width.toFloat()
    val ch = if (sideways) p.width.toFloat() else p.height.toFloat()
    val s = maxOf(w / cw, h / ch)
    texture.post { texture.setTransform(Matrix().apply { setScale(s * cw / w, s * ch / h, w / 2, h / 2) }) }
  }

  @SuppressLint("MissingPermission")
  private fun start(st: SurfaceTexture) {
    if (closed) return
    val p = previewSize()
    st.setDefaultBufferSize(p.width, p.height)
    previewSurface = Surface(st)
    fitPreview()
    // The persistent surface needs a prepared recorder once before the session can use it.
    prepareRecorder(File(context.cacheDir, "iCam_warmup.mp4"), 0, false).release()
    try {
      manager.openCamera(cameraId, object : CameraDevice.StateCallback() {
        override fun onOpened(d: CameraDevice) {
          if (closed) { d.close(); return }
          device = d
          @Suppress("DEPRECATION")
          d.createCaptureSession(listOf(previewSurface!!, persistent), object : CameraCaptureSession.StateCallback() {
            override fun onConfigured(s: CameraCaptureSession) { if (closed) { s.close(); return }; session = s; repeat(false) }
            override fun onConfigureFailed(s: CameraCaptureSession) { onError("This lens rejected 4K at ${size.width}×${size.height}") }
          }, handler)
        }
        override fun onDisconnected(d: CameraDevice) { d.close(); device = null }
        override fun onError(d: CameraDevice, error: Int) { d.close(); device = null; onError("Camera error $error while opening 4K") }
      }, handler)
    } catch (e: Exception) { onError(e.message ?: "Could not open the camera for 4K") }
  }

  private fun repeat(withRecorder: Boolean) {
    val d = device ?: return; val s = session ?: return
    try {
      val b = d.createCaptureRequest(CameraDevice.TEMPLATE_RECORD)
      b.addTarget(previewSurface!!)
      if (withRecorder) b.addTarget(persistent)
      b.set(CaptureRequest.CONTROL_MODE, CaptureRequest.CONTROL_MODE_AUTO)
      b.set(CaptureRequest.CONTROL_AF_MODE, CaptureRequest.CONTROL_AF_MODE_CONTINUOUS_VIDEO)
      // Fixed frame rate: no dynamic drop that makes motion stutter.
      chars.get(CameraCharacteristics.CONTROL_AE_AVAILABLE_TARGET_FPS_RANGES)
        ?.firstOrNull { it.lower == fps && it.upper == fps }?.let { b.set(CaptureRequest.CONTROL_AE_TARGET_FPS_RANGE, it) }
      // Hardware EIS when the lens has it; otherwise optical stabilisation.
      val eis = chars.get(CameraCharacteristics.CONTROL_AVAILABLE_VIDEO_STABILIZATION_MODES)?.contains(CaptureRequest.CONTROL_VIDEO_STABILIZATION_MODE_ON) == true
      if (eis) b.set(CaptureRequest.CONTROL_VIDEO_STABILIZATION_MODE, CaptureRequest.CONTROL_VIDEO_STABILIZATION_MODE_ON)
      else if (chars.get(CameraCharacteristics.LENS_INFO_AVAILABLE_OPTICAL_STABILIZATION)?.contains(CaptureRequest.LENS_OPTICAL_STABILIZATION_MODE_ON) == true)
        b.set(CaptureRequest.LENS_OPTICAL_STABILIZATION_MODE, CaptureRequest.LENS_OPTICAL_STABILIZATION_MODE_ON)
      if (Build.VERSION.SDK_INT >= 30) b.set(CaptureRequest.CONTROL_ZOOM_RATIO, zoom.coerceIn(zoomRange.lower, zoomRange.upper))
      chars.get(CameraCharacteristics.CONTROL_AE_COMPENSATION_RANGE)?.let { b.set(CaptureRequest.CONTROL_AE_EXPOSURE_COMPENSATION, evIndex.coerceIn(it.lower, it.upper)) }
      s.setRepeatingRequest(b.build(), null, handler)
    } catch (e: Exception) { if (!closed) onError(e.message ?: "4K preview failed") }
  }

  fun update() = handler.post { repeat(recording) }

  private fun prepareRecorder(out: File, rotation: Int, audio: Boolean): MediaRecorder {
    val r = if (Build.VERSION.SDK_INT >= 31) MediaRecorder(context) else @Suppress("DEPRECATION") MediaRecorder()
    if (audio) r.setAudioSource(MediaRecorder.AudioSource.CAMCORDER)
    r.setVideoSource(MediaRecorder.VideoSource.SURFACE)
    r.setOutputFormat(MediaRecorder.OutputFormat.MPEG_4)
    r.setOutputFile(out.absolutePath)
    r.setVideoEncoder(if (hevc) MediaRecorder.VideoEncoder.HEVC else MediaRecorder.VideoEncoder.H264)
    r.setVideoSize(size.width, size.height)
    r.setVideoFrameRate(fps)
    r.setVideoEncodingBitRate(if (hevc) bitrate else (bitrate * 1.3).toInt())
    if (audio) {
      r.setAudioEncoder(MediaRecorder.AudioEncoder.AAC)
      r.setAudioSamplingRate(48_000)
      r.setAudioChannels(2)
      r.setAudioEncodingBitRate(256_000)
    }
    r.setOrientationHint(rotation)
    r.setInputSurface(persistent)
    r.prepare()
    return r
  }

  /** deviceDeg: how the phone is held (0/90/180/270). */
  fun startRecording(out: File, deviceDeg: Int, audio: Boolean) {
    check(session != null) { "4K camera is still opening" }
    val rotation = if (front) (sensor - deviceDeg + 360) % 360 else (sensor + deviceDeg) % 360
    val r = prepareRecorder(out, rotation, audio)
    recorder = r; file = out
    repeat(true)
    r.start()
    startedAt = System.currentTimeMillis(); pausedMs = 0; pausedAt = 0
  }

  fun pause() { recorder?.pause(); pausedAt = System.currentTimeMillis() }
  fun resume() { recorder?.resume(); if (pausedAt > 0) pausedMs += System.currentTimeMillis() - pausedAt; pausedAt = 0 }

  /** Returns (file, duration ms, error). */
  fun stopRecording(): Triple<File?, Double, String?> {
    val r = recorder ?: return Triple(null, 0.0, "Not recording")
    val out = file
    val dur = (System.currentTimeMillis() - startedAt - pausedMs).toDouble()
    recorder = null; file = null
    repeat(false)
    return try { r.stop(); Triple(out, dur, null) }
    catch (e: Exception) { Triple(null, dur, "The 4K clip was too short to save") }
    finally { r.release() }
  }

  fun close() {
    closed = true
    try { recorder?.stop() } catch (_: Exception) {}
    try { recorder?.release() } catch (_: Exception) {}
    recorder = null
    try { session?.close() } catch (_: Exception) {}
    try { device?.close() } catch (_: Exception) {}
    session = null; device = null
    try { previewSurface?.release() } catch (_: Exception) {}
    texture.surfaceTextureListener = null
    thread.quitSafely()
    try { persistent.release() } catch (_: Exception) {}
  }
}
