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
  /** Same network with a fixed 208×208 input (accelerators need static shapes) */
  private const val FIXED_MODEL = "realesr_general_x4v3_208.onnx"
  // Bigger, fixed-size tiles: less overlap work, and a fixed shape lets the phone's NPU/GPU run it
  private const val TILE = 192
  private const val PAD = 8
  private const val IN = TILE + 2 * PAD
  private const val SCALE = 4

  @Volatile private var cpu: OrtSession? = null
  @Volatile private var accel: OrtSession? = null
  @Volatile private var accelBad = false
  private val lock = Any()

  fun available(ctx: Context): Boolean = try {
    ctx.assets.open(MODEL).close(); true
  } catch (e: Throwable) { false }

  private fun modelBytes(ctx: Context) = ctx.assets.open(MODEL).use { it.readBytes() }

  private fun cpuSession(ctx: Context): OrtSession {
    cpu?.let { return it }
    synchronized(lock) {
      cpu?.let { return it }
      val threads = Runtime.getRuntime().availableProcessors().coerceIn(2, 8)
      val opts = OrtSession.SessionOptions().apply {
        setOptimizationLevel(OrtSession.SessionOptions.OptLevel.ALL_OPT)
        setIntraOpNumThreads(threads)
        try { addXnnpack(mapOf("intra_op_num_threads" to threads.toString())) } catch (_: Throwable) {}
      }
      return OrtEnvironment.getEnvironment().createSession(modelBytes(ctx), opts).also { cpu = it }
    }
  }

  /** The phone's neural/graphics accelerator (NNAPI, half precision); null if unavailable or misbehaving. */
  private fun accelSession(ctx: Context): OrtSession? {
    if (accelBad) return null
    accel?.let { return it }
    synchronized(lock) {
      accel?.let { return it }
      return try {
        val opts = OrtSession.SessionOptions().apply {
          setOptimizationLevel(OrtSession.SessionOptions.OptLevel.ALL_OPT)
          addNnapi(java.util.EnumSet.of(ai.onnxruntime.providers.NNAPIFlags.USE_FP16))
        }
        val fixed = ctx.assets.open(FIXED_MODEL).use { it.readBytes() }
        OrtEnvironment.getEnvironment().createSession(fixed, opts).also { accel = it }
      } catch (e: Throwable) { accelBad = true; null }
    }
  }

  private fun run(sess: OrtSession, fb: FloatBuffer): FloatArray {
    val env = OrtEnvironment.getEnvironment()
    fb.rewind()
    OnnxTensor.createTensor(env, fb, longArrayOf(1, 3, IN.toLong(), IN.toLong())).use { tensor ->
      sess.run(mapOf(sess.inputNames.first() to tensor)).use { res ->
        val o = (res[0] as OnnxTensor).floatBuffer
        val arr = FloatArray(o.remaining())
        o.get(arr)
        return arr
      }
    }
  }

  /** Upscales [inPath] 4× (input first limited to [maxEdge] px on its long side). */
  fun upscale(ctx: Context, inPath: String, outPath: String, maxEdge: Int): Map<String, Any> {
    val t0 = System.currentTimeMillis()
    val acc = accelSession(ctx)
    // Without an accelerator the CPU does all the work: use a smaller crop so it stays quick
    val edge = if (acc != null) maxEdge else minOf(maxEdge, 384)
    var src = BitmapFactory.decodeFile(inPath.removePrefix("file://"))
      ?: throw IllegalArgumentException("Could not read image")
    val long = maxOf(src.width, src.height)
    if (long > edge) {
      val s = edge.toFloat() / long
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
    var sess: OrtSession = acc ?: cpuSession(ctx)
    var checked = acc == null
    val plane = IN * IN
    val fb = FloatBuffer.allocate(3 * plane)
    val arr = fb.array()
    val oiw = IN * SCALE
    val oplane = oiw * oiw

    var ty = 0
    while (ty < h) {
      var tx = 0
      while (tx < w) {
        val tw = minOf(TILE, w - tx)
        val th = minOf(TILE, h - ty)
        // fixed-size input: the tile plus a border, edge pixels repeated past the image
        val x0 = tx - PAD
        val y0 = ty - PAD
        var inSum = 0.0
        for (y in 0 until IN) {
          val sy = (y0 + y).coerceIn(0, h - 1) * w
          for (x in 0 until IN) {
            val c = px[sy + (x0 + x).coerceIn(0, w - 1)]
            val i = y * IN + x
            val r = ((c shr 16) and 0xff) / 255f
            val g = ((c shr 8) and 0xff) / 255f
            val b = (c and 0xff) / 255f
            arr[i] = r; arr[plane + i] = g; arr[2 * plane + i] = b
            inSum += r + g + b
          }
        }
        var o = try { run(sess, fb) } catch (e: Throwable) {
          if (sess === acc) { accelBad = true; sess = cpuSession(ctx); checked = true; run(sess, fb) } else throw e
        }
        if (!checked) {
          // Some accelerator drivers return garbage: compare brightness with the input once
          checked = true
          var outSum = 0.0
          for (v in o) outSum += v
          val a = inSum / (3.0 * plane)
          val b = outSum / o.size
          if (b.isNaN() || Math.abs(a - b) > 0.06) {
            accelBad = true
            sess = cpuSession(ctx)
            o = run(sess, fb)
          }
        }
        // copy only the tile's own area (without the border) into the output
        val ox0 = PAD * SCALE
        val oy0 = PAD * SCALE
        for (y in 0 until th * SCALE) {
          val row = (oy0 + y) * oiw
          val dst = (ty * SCALE + y) * ow + tx * SCALE
          for (x in 0 until tw * SCALE) {
            val i = row + ox0 + x
            val r = (o[i] * 255f + 0.5f).toInt().coerceIn(0, 255)
            val g = (o[oplane + i] * 255f + 0.5f).toInt().coerceIn(0, 255)
            val b = (o[2 * oplane + i] * 255f + 0.5f).toInt().coerceIn(0, 255)
            out[dst + x] = (0xff shl 24) or (r shl 16) or (g shl 8) or b
          }
        }
        tx += TILE
      }
      ty += TILE
    }
    val bmp = Bitmap.createBitmap(out, ow, oh, Bitmap.Config.ARGB_8888)
    val file = File(outPath.removePrefix("file://"))
    FileOutputStream(file).use { bmp.compress(Bitmap.CompressFormat.JPEG, 95, it) }
    bmp.recycle()
    return mapOf(
      "path" to file.absolutePath, "width" to ow, "height" to oh,
      "ms" to (System.currentTimeMillis() - t0).toDouble(), "accelerated" to (sess === accel && !accelBad),
    )
  }
}
