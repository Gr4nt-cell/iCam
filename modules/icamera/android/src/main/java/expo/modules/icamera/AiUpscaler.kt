package expo.modules.icamera

import ai.onnxruntime.OnnxTensor
import ai.onnxruntime.OrtEnvironment
import ai.onnxruntime.OrtSession
import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import java.io.File
import java.io.FileOutputStream
import java.nio.FloatBuffer

/**
 * On-device AI super-resolution (Real-ESRGAN general x4v3, BSD-3-Clause) through ONNX Runtime.
 * Used for long-zoom photos: the zoomed crop is upscaled 4× by the network, which rebuilds edges and
 * fine texture instead of just interpolating. Runs tiled so memory stays small.
 */
object AiUpscaler {
  private const val MODEL = "realesr_general_x4v3.onnx"
  private const val TILE = 128
  private const val PAD = 10
  private const val SCALE = 4

  @Volatile private var session: OrtSession? = null
  private val lock = Any()

  fun available(ctx: Context): Boolean = try {
    ctx.assets.open(MODEL).close(); true
  } catch (e: Throwable) { false }

  private fun session(ctx: Context): OrtSession {
    session?.let { return it }
    synchronized(lock) {
      session?.let { return it }
      val env = OrtEnvironment.getEnvironment()
      val bytes = ctx.assets.open(MODEL).use { it.readBytes() }
      val threads = Runtime.getRuntime().availableProcessors().coerceIn(2, 6)
      val opts = OrtSession.SessionOptions().apply {
        setOptimizationLevel(OrtSession.SessionOptions.OptLevel.ALL_OPT)
        setIntraOpNumThreads(threads)
        try { addXnnpack(mapOf("intra_op_num_threads" to threads.toString())) } catch (_: Throwable) {}
      }
      return env.createSession(bytes, opts).also { session = it }
    }
  }

  /** Upscales [inPath] 4× (input first limited to [maxEdge] px on its long side). */
  fun upscale(ctx: Context, inPath: String, outPath: String, maxEdge: Int): Map<String, Any> {
    val t0 = System.currentTimeMillis()
    var src = BitmapFactory.decodeFile(inPath.removePrefix("file://"))
      ?: throw IllegalArgumentException("Could not read image")
    val long = maxOf(src.width, src.height)
    if (long > maxEdge) {
      val s = maxEdge.toFloat() / long
      val scaled = Bitmap.createScaledBitmap(src, (src.width * s).toInt().coerceAtLeast(8), (src.height * s).toInt().coerceAtLeast(8), true)
      src.recycle(); src = scaled
    }
    val w = src.width
    val h = src.height
    val px = IntArray(w * h)
    src.getPixels(px, 0, w, 0, 0, w, h)
    src.recycle()

    val ow = w * SCALE
    val oh = h * SCALE
    val out = IntArray(ow * oh)
    val sess = session(ctx)
    val env = OrtEnvironment.getEnvironment()
    val inputName = sess.inputNames.first()

    var ty = 0
    while (ty < h) {
      var tx = 0
      while (tx < w) {
        val tw = minOf(TILE, w - tx)
        val th = minOf(TILE, h - ty)
        // tile + padding (clamped to the image) so seams don't show
        val x0 = maxOf(0, tx - PAD)
        val y0 = maxOf(0, ty - PAD)
        val x1 = minOf(w, tx + tw + PAD)
        val y1 = minOf(h, ty + th + PAD)
        val iw = x1 - x0
        val ih = y1 - y0
        val plane = iw * ih
        val fb = FloatBuffer.allocate(3 * plane)
        val arr = fb.array()
        for (y in 0 until ih) for (x in 0 until iw) {
          val c = px[(y0 + y) * w + (x0 + x)]
          val i = y * iw + x
          arr[i] = ((c shr 16) and 0xff) / 255f
          arr[plane + i] = ((c shr 8) and 0xff) / 255f
          arr[2 * plane + i] = (c and 0xff) / 255f
        }
        OnnxTensor.createTensor(env, fb, longArrayOf(1, 3, ih.toLong(), iw.toLong())).use { tensor ->
          sess.run(mapOf(inputName to tensor)).use { res ->
            val o = (res[0] as OnnxTensor).floatBuffer
            val oiw = iw * SCALE
            val oplane = oiw * ih * SCALE
            // copy only the tile's own area (without padding) into the output
            val ox0 = (tx - x0) * SCALE
            val oy0 = (ty - y0) * SCALE
            for (y in 0 until th * SCALE) {
              val row = (oy0 + y) * oiw
              val dst = (ty * SCALE + y) * ow + tx * SCALE
              for (x in 0 until tw * SCALE) {
                val i = row + ox0 + x
                val r = (o.get(i) * 255f + 0.5f).toInt().coerceIn(0, 255)
                val g = (o.get(oplane + i) * 255f + 0.5f).toInt().coerceIn(0, 255)
                val b = (o.get(2 * oplane + i) * 255f + 0.5f).toInt().coerceIn(0, 255)
                out[dst + x] = (0xff shl 24) or (r shl 16) or (g shl 8) or b
              }
            }
          }
        }
        tx += TILE
      }
      ty += TILE
    }
    val bmp = Bitmap.createBitmap(out, ow, oh, Bitmap.Config.ARGB_8888)
    val file = File(outPath.removePrefix("file://"))
    FileOutputStream(file).use { bmp.compress(Bitmap.CompressFormat.JPEG, 97, it) }
    bmp.recycle()
    return mapOf("path" to file.absolutePath, "width" to ow, "height" to oh, "ms" to (System.currentTimeMillis() - t0).toDouble())
  }
}
