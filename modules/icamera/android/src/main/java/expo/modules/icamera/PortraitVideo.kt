package expo.modules.icamera

import android.graphics.Bitmap
import android.graphics.Matrix
import android.graphics.SurfaceTexture
import android.opengl.EGL14
import android.opengl.EGLConfig
import android.opengl.EGLContext
import android.opengl.EGLDisplay
import android.opengl.EGLExt
import android.opengl.EGLSurface
import android.opengl.GLES11Ext
import android.opengl.GLES20
import android.os.Handler
import android.os.HandlerThread
import android.util.Size
import android.view.Surface
import androidx.camera.core.CameraEffect
import androidx.camera.core.SurfaceOutput
import androidx.camera.core.SurfaceProcessor
import androidx.camera.core.SurfaceRequest
import androidx.core.util.Consumer
import com.google.android.gms.tasks.Tasks
import com.google.mlkit.vision.common.InputImage
import com.google.mlkit.vision.segmentation.Segmentation
import com.google.mlkit.vision.segmentation.Segmenter
import com.google.mlkit.vision.segmentation.selfie.SelfieSegmenterOptions
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.nio.FloatBuffer
import java.util.concurrent.Executor
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

/** CameraX effect that renders Portrait video (preview + recording) through [PortraitProcessor]. */
class PortraitVideoEffect(processor: PortraitProcessor) : CameraEffect(
  CameraEffect.PREVIEW or CameraEffect.VIDEO_CAPTURE,
  processor.executor,
  processor,
  Consumer<Throwable> { },
)

/**
 * Real-time background blur for video:
 *  - camera frames arrive as an OES texture; every frame is drawn to each output (preview, encoder)
 *    with a lens-style disc blur on the background only
 *  - ~10×/s a small copy of the frame is read back and run through ML Kit selfie segmentation
 *    (on-device); the mask is smoothed over time and uploaded as a texture
 *  - the frame orientation for segmentation is detected automatically (tries all 4 rotations and
 *    keeps the one where a person is found most confidently), then re-checked every few seconds
 */
class PortraitProcessor : SurfaceProcessor {
  private val thread = HandlerThread("iCamPortraitGL").apply { start() }
  private val handler = Handler(thread.looper)
  val executor = Executor { handler.post(it) }
  private val segExecutor = Executors.newSingleThreadExecutor()

  @Volatile var strength = 0.6f

  /** Called (on the GL thread) when the blur is switched off because the GPU is too slow. */
  var onWeakGpu: ((String) -> Unit)? = null
  @Volatile private var blurDisabled = false
  private var slowFrames = 0
  private var renderer = ""

  private val streamSeg: Segmenter by lazy {
    Segmentation.getClient(
      SelfieSegmenterOptions.Builder().setDetectorMode(SelfieSegmenterOptions.STREAM_MODE).build(),
    )
  }
  private val singleSeg: Segmenter by lazy {
    Segmentation.getClient(
      SelfieSegmenterOptions.Builder().setDetectorMode(SelfieSegmenterOptions.SINGLE_IMAGE_MODE).build(),
    )
  }

  // EGL / GL state (GL thread only)
  private var display: EGLDisplay = EGL14.EGL_NO_DISPLAY
  private var context: EGLContext = EGL14.EGL_NO_CONTEXT
  private var config: EGLConfig? = null
  private var pbuffer: EGLSurface = EGL14.EGL_NO_SURFACE
  private var oesTex = 0
  private var maskTex = 0
  private var fbo = 0
  private var fboTex = 0
  private var fboW = 0
  private var fboH = 0
  private var blurProg = 0
  private var copyProg = 0
  private var st: SurfaceTexture? = null
  private var inW = 1920
  private var inH = 1080
  private val outputs = LinkedHashMap<SurfaceOutput, Pair<EGLSurface, Size>>()
  private val stM = FloatArray(16)
  private val outM = FloatArray(16)
  private var frame = 0L
  private var released = false

  // Segmentation state
  @Volatile private var segBusy = false
  private var rot = -1 // clockwise quarter turns applied before segmentation; -1 = unknown
  private var lastRotCheck = 0L
  private var mask: FloatArray? = null
  private var maskW = 0
  private var maskH = 0
  private var maskDirty = false
  private var maskReady = false

  private val quadPos: FloatBuffer = floatBuffer(floatArrayOf(-1f, -1f, 1f, -1f, -1f, 1f, 1f, 1f))
  private val quadTex: FloatBuffer = floatBuffer(floatArrayOf(0f, 0f, 1f, 0f, 0f, 1f, 1f, 1f))

  /* ---------------- SurfaceProcessor ---------------- */

  override fun onInputSurface(request: SurfaceRequest) {
    if (released) { request.willNotProvideSurface(); return }
    initGl()
    inW = request.resolution.width
    inH = request.resolution.height
    val tex = IntArray(1)
    GLES20.glGenTextures(1, tex, 0)
    oesTex = tex[0]
    GLES20.glBindTexture(GLES11Ext.GL_TEXTURE_EXTERNAL_OES, oesTex)
    GLES20.glTexParameteri(GLES11Ext.GL_TEXTURE_EXTERNAL_OES, GLES20.GL_TEXTURE_MIN_FILTER, GLES20.GL_LINEAR)
    GLES20.glTexParameteri(GLES11Ext.GL_TEXTURE_EXTERNAL_OES, GLES20.GL_TEXTURE_MAG_FILTER, GLES20.GL_LINEAR)
    GLES20.glTexParameteri(GLES11Ext.GL_TEXTURE_EXTERNAL_OES, GLES20.GL_TEXTURE_WRAP_S, GLES20.GL_CLAMP_TO_EDGE)
    GLES20.glTexParameteri(GLES11Ext.GL_TEXTURE_EXTERNAL_OES, GLES20.GL_TEXTURE_WRAP_T, GLES20.GL_CLAMP_TO_EDGE)
    val surfaceTexture = SurfaceTexture(oesTex)
    surfaceTexture.setDefaultBufferSize(inW, inH)
    val surface = Surface(surfaceTexture)
    surfaceTexture.setOnFrameAvailableListener({ render() }, handler)
    st = surfaceTexture
    request.provideSurface(surface, executor) {
      surfaceTexture.setOnFrameAvailableListener(null)
      surfaceTexture.release()
      surface.release()
      if (st === surfaceTexture) st = null
    }
  }

  override fun onOutputSurface(surfaceOutput: SurfaceOutput) {
    if (released) { surfaceOutput.close(); return }
    initGl()
    val surface = surfaceOutput.getSurface(executor) {
      outputs.remove(surfaceOutput)?.let { EGL14.eglDestroySurface(display, it.first) }
      surfaceOutput.close()
    }
    val es = EGL14.eglCreateWindowSurface(display, config, surface, intArrayOf(EGL14.EGL_NONE), 0)
    outputs[surfaceOutput] = es to surfaceOutput.size
  }

  fun release() {
    handler.post {
      released = true
      outputs.forEach { (out, p) -> EGL14.eglDestroySurface(display, p.first); out.close() }
      outputs.clear()
      st?.release(); st = null
      if (display != EGL14.EGL_NO_DISPLAY) {
        EGL14.eglMakeCurrent(display, EGL14.EGL_NO_SURFACE, EGL14.EGL_NO_SURFACE, EGL14.EGL_NO_CONTEXT)
        if (pbuffer != EGL14.EGL_NO_SURFACE) EGL14.eglDestroySurface(display, pbuffer)
        EGL14.eglDestroyContext(display, context)
        EGL14.eglTerminate(display)
      }
      display = EGL14.EGL_NO_DISPLAY
      segExecutor.shutdown()
      try { streamSeg.close(); singleSeg.close() } catch (_: Throwable) {}
      thread.quitSafely()
    }
  }

  /* ---------------- rendering ---------------- */

  private fun render() {
    val s = st ?: return
    if (released) return
    EGL14.eglMakeCurrent(display, pbuffer, pbuffer, context)
    try { s.updateTexImage() } catch (e: Throwable) { return }
    s.getTransformMatrix(stM)
    frame++

    val t0 = System.nanoTime()
    if (!blurDisabled && frame % 3L == 0L && !segBusy) captureForSegmentation()
    uploadMask()

    for ((out, p) in outputs) {
      val (es, size) = p
      if (!EGL14.eglMakeCurrent(display, es, es, context)) continue
      GLES20.glViewport(0, 0, size.width, size.height)
      out.updateTransformMatrix(outM, stM)
      drawBlur(outM)
      EGLExt.eglPresentationTimeANDROID(display, es, s.timestamp)
      EGL14.eglSwapBuffers(display, es)
    }

    // Runtime check: if blurring keeps us under ~22 fps for ~2 s, switch it off
    if (!blurDisabled && maskReady && frame > 30) {
      val ms = (System.nanoTime() - t0) / 1_000_000.0
      slowFrames = if (ms > 45.0) slowFrames + 1 else maxOf(0, slowFrames - 1)
      if (slowFrames > 45) disableBlur("Background blur was too slow on this phone and has been turned off")
    }
  }

  private fun disableBlur(reason: String) {
    if (blurDisabled) return
    blurDisabled = true
    onWeakGpu?.invoke(reason)
  }

  private fun isKnownWeakGpu(r: String): Boolean {
    val g = r.lowercase()
    return listOf(
      "mali-4", "mali-t6", "mali-t7", "mali-g31", "mali-g51", "mali-g52 mc1",
      "adreno (tm) 3", "adreno (tm) 4", "adreno (tm) 50", "adreno (tm) 51",
      "powervr sgx", "powervr rogue ge", "powervr rogue gm", "powervr ge8",
      "videocore", "vivante",
    ).any { g.contains(it) }
  }

  private fun drawBlur(texMatrix: FloatArray) {
    GLES20.glUseProgram(blurProg)
    bindQuad(blurProg, texMatrix)
    GLES20.glActiveTexture(GLES20.GL_TEXTURE0)
    GLES20.glBindTexture(GLES11Ext.GL_TEXTURE_EXTERNAL_OES, oesTex)
    GLES20.glUniform1i(GLES20.glGetUniformLocation(blurProg, "sTex"), 0)
    GLES20.glActiveTexture(GLES20.GL_TEXTURE1)
    GLES20.glBindTexture(GLES20.GL_TEXTURE_2D, maskTex)
    GLES20.glUniform1i(GLES20.glGetUniformLocation(blurProg, "sMask"), 1)
    GLES20.glUniform2f(GLES20.glGetUniformLocation(blurProg, "uTexel"), 1f / inW, 1f / inH)
    val radius = (minOf(inW, inH) / 28f) * (0.35f + strength * 1.2f)
    GLES20.glUniform1f(GLES20.glGetUniformLocation(blurProg, "uRadius"), radius)
    GLES20.glUniform1i(GLES20.glGetUniformLocation(blurProg, "uRot"), if (maskReady && rot >= 0) rot else -1)
    GLES20.glUniform1f(GLES20.glGetUniformLocation(blurProg, "uStrength"), if (blurDisabled) 0f else strength)
    GLES20.glDrawArrays(GLES20.GL_TRIANGLE_STRIP, 0, 4)
  }

  private fun bindQuad(prog: Int, texMatrix: FloatArray) {
    val aPos = GLES20.glGetAttribLocation(prog, "aPos")
    val aTex = GLES20.glGetAttribLocation(prog, "aTex")
    GLES20.glEnableVertexAttribArray(aPos)
    GLES20.glVertexAttribPointer(aPos, 2, GLES20.GL_FLOAT, false, 0, quadPos)
    GLES20.glEnableVertexAttribArray(aTex)
    GLES20.glVertexAttribPointer(aTex, 2, GLES20.GL_FLOAT, false, 0, quadTex)
    GLES20.glUniformMatrix4fv(GLES20.glGetUniformLocation(prog, "uTexMatrix"), 1, false, texMatrix, 0)
  }

  /* ---------------- segmentation ---------------- */

  /** Renders the raw frame (buffer space) into a small FBO and reads it back for ML Kit. */
  private fun captureForSegmentation() {
    val w = 256
    val h = maxOf(32, (256f * inH / inW).toInt())
    ensureFbo(w, h)
    GLES20.glBindFramebuffer(GLES20.GL_FRAMEBUFFER, fbo)
    GLES20.glViewport(0, 0, w, h)
    GLES20.glUseProgram(copyProg)
    bindQuad(copyProg, stM)
    GLES20.glActiveTexture(GLES20.GL_TEXTURE0)
    GLES20.glBindTexture(GLES11Ext.GL_TEXTURE_EXTERNAL_OES, oesTex)
    GLES20.glUniform1i(GLES20.glGetUniformLocation(copyProg, "sTex"), 0)
    GLES20.glDrawArrays(GLES20.GL_TRIANGLE_STRIP, 0, 4)
    val buf = ByteBuffer.allocateDirect(w * h * 4).order(ByteOrder.nativeOrder())
    GLES20.glReadPixels(0, 0, w, h, GLES20.GL_RGBA, GLES20.GL_UNSIGNED_BYTE, buf)
    GLES20.glBindFramebuffer(GLES20.GL_FRAMEBUFFER, 0)
    buf.rewind()
    // Bitmap row 0 = top; glReadPixels row 0 = bottom → bitmap y = (1 - v) * h (the shader assumes this)
    val bmp = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888)
    bmp.copyPixelsFromBuffer(buf)
    val flipped = Bitmap.createBitmap(bmp, 0, 0, w, h, Matrix().apply { setScale(1f, -1f) }, false)
    bmp.recycle()

    segBusy = true
    val checkRotation = rot < 0 || System.currentTimeMillis() - lastRotCheck > 4000
    segExecutor.execute {
      try {
        var useRot = rot
        if (checkRotation) {
          useRot = bestRotation(flipped)
          lastRotCheck = System.currentTimeMillis()
        }
        if (useRot < 0) { flipped.recycle(); segBusy = false; return@execute }
        val input = rotated(flipped, useRot)
        val m = Tasks.await(streamSeg.process(InputImage.fromBitmap(input, 0)), 2, TimeUnit.SECONDS)
        val mw = m.width
        val mh = m.height
        val fb = m.buffer
        fb.rewind()
        val arr = FloatArray(mw * mh) { fb.getFloat() }
        if (input !== flipped) input.recycle()
        flipped.recycle()
        handler.post {
          val prev = mask
          if (prev != null && prev.size == arr.size && useRot == rot) {
            for (i in arr.indices) arr[i] = arr[i] * 0.65f + prev[i] * 0.35f // temporal smoothing
          }
          rot = useRot
          mask = arr; maskW = mw; maskH = mh; maskDirty = true
          segBusy = false
        }
      } catch (e: Throwable) {
        segBusy = false
      }
    }
  }

  /** Finds how many clockwise quarter turns make the person upright (highest-confidence mask). */
  private fun bestRotation(bmp: Bitmap): Int {
    var best = -1
    var bestScore = 0.0
    for (r in 0..3) {
      val input = rotated(bmp, r)
      val m = try {
        Tasks.await(singleSeg.process(InputImage.fromBitmap(input, 0)), 2, TimeUnit.SECONDS)
      } catch (e: Throwable) { null }
      if (input !== bmp) input.recycle()
      if (m == null) continue
      val fb = m.buffer
      fb.rewind()
      var score = 0.0
      var count = 0
      val n = m.width * m.height
      for (i in 0 until n) {
        val v = fb.getFloat()
        if (v > 0.6f) { score += v; count++ }
      }
      val coverage = count.toDouble() / n
      if (coverage in 0.02..0.85 && score > bestScore) { bestScore = score; best = r }
    }
    return if (best >= 0) best else rot
  }

  private fun rotated(bmp: Bitmap, quarterTurns: Int): Bitmap {
    if (quarterTurns == 0) return bmp
    val m = Matrix().apply { postRotate(90f * quarterTurns) }
    return Bitmap.createBitmap(bmp, 0, 0, bmp.width, bmp.height, m, true)
  }

  private fun uploadMask() {
    if (!maskDirty) return
    val m = mask ?: return
    maskDirty = false
    val bytes = ByteBuffer.allocateDirect(m.size)
    for (v in m) bytes.put((v.coerceIn(0f, 1f) * 255f).toInt().toByte())
    bytes.rewind()
    GLES20.glActiveTexture(GLES20.GL_TEXTURE1)
    GLES20.glBindTexture(GLES20.GL_TEXTURE_2D, maskTex)
    GLES20.glPixelStorei(GLES20.GL_UNPACK_ALIGNMENT, 1)
    GLES20.glTexImage2D(GLES20.GL_TEXTURE_2D, 0, GLES20.GL_LUMINANCE, maskW, maskH, 0, GLES20.GL_LUMINANCE, GLES20.GL_UNSIGNED_BYTE, bytes)
    maskReady = true
  }

  /* ---------------- GL setup ---------------- */

  private fun initGl() {
    if (display != EGL14.EGL_NO_DISPLAY) return
    display = EGL14.eglGetDisplay(EGL14.EGL_DEFAULT_DISPLAY)
    val ver = IntArray(2)
    EGL14.eglInitialize(display, ver, 0, ver, 1)
    val attribs = intArrayOf(
      EGL14.EGL_RED_SIZE, 8, EGL14.EGL_GREEN_SIZE, 8, EGL14.EGL_BLUE_SIZE, 8, EGL14.EGL_ALPHA_SIZE, 8,
      EGL14.EGL_RENDERABLE_TYPE, EGL14.EGL_OPENGL_ES2_BIT,
      EGL14.EGL_SURFACE_TYPE, EGL14.EGL_WINDOW_BIT or EGL14.EGL_PBUFFER_BIT,
      0x3142, 1, // EGL_RECORDABLE_ANDROID: can render into the video encoder's surface
      EGL14.EGL_NONE,
    )
    val configs = arrayOfNulls<EGLConfig>(1)
    val num = IntArray(1)
    EGL14.eglChooseConfig(display, attribs, 0, configs, 0, 1, num, 0)
    config = configs[0]
    context = EGL14.eglCreateContext(
      display, config, EGL14.EGL_NO_CONTEXT, intArrayOf(EGL14.EGL_CONTEXT_CLIENT_VERSION, 2, EGL14.EGL_NONE), 0,
    )
    pbuffer = EGL14.eglCreatePbufferSurface(display, config, intArrayOf(EGL14.EGL_WIDTH, 1, EGL14.EGL_HEIGHT, 1, EGL14.EGL_NONE), 0)
    EGL14.eglMakeCurrent(display, pbuffer, pbuffer, context)

    renderer = GLES20.glGetString(GLES20.GL_RENDERER) ?: ""
    if (isKnownWeakGpu(renderer)) disableBlur("This phone's GPU ($renderer) is too slow for live background blur")

    blurProg = program(VERTEX, BLUR_FRAGMENT)
    copyProg = program(VERTEX, COPY_FRAGMENT)
    val t = IntArray(1)
    GLES20.glGenTextures(1, t, 0)
    maskTex = t[0]
    GLES20.glBindTexture(GLES20.GL_TEXTURE_2D, maskTex)
    GLES20.glTexParameteri(GLES20.GL_TEXTURE_2D, GLES20.GL_TEXTURE_MIN_FILTER, GLES20.GL_LINEAR)
    GLES20.glTexParameteri(GLES20.GL_TEXTURE_2D, GLES20.GL_TEXTURE_MAG_FILTER, GLES20.GL_LINEAR)
    GLES20.glTexParameteri(GLES20.GL_TEXTURE_2D, GLES20.GL_TEXTURE_WRAP_S, GLES20.GL_CLAMP_TO_EDGE)
    GLES20.glTexParameteri(GLES20.GL_TEXTURE_2D, GLES20.GL_TEXTURE_WRAP_T, GLES20.GL_CLAMP_TO_EDGE)
    // start with an all-foreground mask (no blur until the first segmentation arrives)
    val one = ByteBuffer.allocateDirect(1).put(255.toByte()).also { it.rewind() }
    GLES20.glPixelStorei(GLES20.GL_UNPACK_ALIGNMENT, 1)
    GLES20.glTexImage2D(GLES20.GL_TEXTURE_2D, 0, GLES20.GL_LUMINANCE, 1, 1, 0, GLES20.GL_LUMINANCE, GLES20.GL_UNSIGNED_BYTE, one)
  }

  private fun ensureFbo(w: Int, h: Int) {
    if (fbo != 0 && fboW == w && fboH == h) return
    if (fbo != 0) {
      GLES20.glDeleteFramebuffers(1, intArrayOf(fbo), 0)
      GLES20.glDeleteTextures(1, intArrayOf(fboTex), 0)
    }
    val t = IntArray(1)
    GLES20.glGenTextures(1, t, 0)
    fboTex = t[0]
    GLES20.glBindTexture(GLES20.GL_TEXTURE_2D, fboTex)
    GLES20.glTexImage2D(GLES20.GL_TEXTURE_2D, 0, GLES20.GL_RGBA, w, h, 0, GLES20.GL_RGBA, GLES20.GL_UNSIGNED_BYTE, null)
    GLES20.glTexParameteri(GLES20.GL_TEXTURE_2D, GLES20.GL_TEXTURE_MIN_FILTER, GLES20.GL_LINEAR)
    GLES20.glTexParameteri(GLES20.GL_TEXTURE_2D, GLES20.GL_TEXTURE_MAG_FILTER, GLES20.GL_LINEAR)
    val f = IntArray(1)
    GLES20.glGenFramebuffers(1, f, 0)
    fbo = f[0]
    GLES20.glBindFramebuffer(GLES20.GL_FRAMEBUFFER, fbo)
    GLES20.glFramebufferTexture2D(GLES20.GL_FRAMEBUFFER, GLES20.GL_COLOR_ATTACHMENT0, GLES20.GL_TEXTURE_2D, fboTex, 0)
    GLES20.glBindFramebuffer(GLES20.GL_FRAMEBUFFER, 0)
    fboW = w; fboH = h
  }

  private fun program(vs: String, fs: String): Int {
    fun shader(type: Int, src: String): Int {
      val s = GLES20.glCreateShader(type)
      GLES20.glShaderSource(s, src)
      GLES20.glCompileShader(s)
      val ok = IntArray(1)
      GLES20.glGetShaderiv(s, GLES20.GL_COMPILE_STATUS, ok, 0)
      if (ok[0] == 0) throw IllegalStateException("Shader: " + GLES20.glGetShaderInfoLog(s))
      return s
    }
    val p = GLES20.glCreateProgram()
    GLES20.glAttachShader(p, shader(GLES20.GL_VERTEX_SHADER, vs))
    GLES20.glAttachShader(p, shader(GLES20.GL_FRAGMENT_SHADER, fs))
    GLES20.glLinkProgram(p)
    return p
  }

  private fun floatBuffer(a: FloatArray): FloatBuffer =
    ByteBuffer.allocateDirect(a.size * 4).order(ByteOrder.nativeOrder()).asFloatBuffer().apply { put(a); position(0) }

  companion object {
    private const val VERTEX = """
      attribute vec4 aPos;
      attribute vec4 aTex;
      uniform mat4 uTexMatrix;
      varying vec2 vTex;
      void main() {
        gl_Position = aPos;
        vTex = (uTexMatrix * aTex).xy;
      }
    """

    private const val COPY_FRAGMENT = """
      #extension GL_OES_EGL_image_external : require
      precision mediump float;
      varying vec2 vTex;
      uniform samplerExternalOES sTex;
      void main() { gl_FragColor = vec4(texture2D(sTex, vTex).rgb, 1.0); }
    """

    // Disc blur of the background (24-tap golden-angle spiral), weighted against the person so
    // their colours don't bleed, with bright points blooming like bokeh.
    private const val BLUR_FRAGMENT = """
      #extension GL_OES_EGL_image_external : require
      precision highp float;
      varying vec2 vTex;
      uniform samplerExternalOES sTex;
      uniform sampler2D sMask;
      uniform vec2 uTexel;
      uniform float uRadius;
      uniform int uRot;
      uniform float uStrength;

      vec2 maskUV(vec2 t) {
        vec2 b = vec2(t.x, 1.0 - t.y);
        if (uRot == 1) return vec2(1.0 - b.y, b.x);
        if (uRot == 2) return vec2(1.0 - b.x, 1.0 - b.y);
        if (uRot == 3) return vec2(b.y, 1.0 - b.x);
        return b;
      }
      float person(vec2 t) { return smoothstep(0.3, 0.7, texture2D(sMask, maskUV(t)).r); }

      void main() {
        vec4 c = texture2D(sTex, vTex);
        if (uRot < 0 || uStrength <= 0.01) { gl_FragColor = vec4(c.rgb, 1.0); return; }
        float mc = person(vTex);
        if (mc > 0.985) { gl_FragColor = vec4(c.rgb, 1.0); return; }
        vec3 acc = vec3(0.0);
        float w = 0.0;
        for (int i = 0; i < 24; i++) {
          float fi = float(i);
          float a = fi * 2.39996;
          float r = sqrt((fi + 0.5) / 24.0) * uRadius;
          vec2 q = vTex + vec2(cos(a), sin(a)) * r * uTexel;
          vec3 s = texture2D(sTex, q).rgb;
          float l = dot(s, vec3(0.299, 0.587, 0.114));
          float k = (1.0 - person(q) * 0.97) * (1.0 + 2.0 * smoothstep(0.8, 1.0, l));
          acc += s * k;
          w += k;
        }
        vec3 bg = w > 0.001 ? acc / w : c.rgb;
        gl_FragColor = vec4(mix(bg, c.rgb, mc), 1.0);
      }
    """
  }
}
