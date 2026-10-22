package expo.modules.icamera

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Matrix
import android.graphics.RectF
import java.io.File
import kotlin.math.sqrt

/**
 * Some phones' camera firmware mirrors front-camera JPEGs, most don't. Instead of guessing, compare
 * the saved photo with what the (mirrored) preview showed at the moment of capture.
 */
object MirrorCheck {
  private const val N = 32

  /** 1 = JPEG already mirrored, 0 = normal (true view), -1 = can't tell. */
  fun jpegMirrored(file: File, exif: Int, w: Int, h: Int, preview: Bitmap, fit: Boolean): Int {
    if (w <= 0 || h <= 0 || preview.width < 8 || preview.height < 8) return -1
    var sample = 1
    while (maxOf(w, h) / (sample * 2) >= 320) sample *= 2
    val raw = BitmapFactory.decodeFile(file.absolutePath, BitmapFactory.Options().apply { inSampleSize = sample }) ?: return -1
    val m = Matrix()
    when (exif) {
      2 -> m.setScale(-1f, 1f)
      3 -> m.setRotate(180f)
      4 -> { m.setRotate(180f); m.postScale(-1f, 1f) }
      5 -> { m.setRotate(90f); m.postScale(-1f, 1f) }
      6 -> m.setRotate(90f)
      7 -> { m.setRotate(-90f); m.postScale(-1f, 1f) }
      8 -> m.setRotate(-90f)
    }
    val up = if (m.isIdentity) raw else Bitmap.createBitmap(raw, 0, 0, raw.width, raw.height, m, true)

    val ai = up.width.toFloat() / up.height
    val vw = preview.width.toFloat()
    val vh = preview.height.toFloat()
    val av = vw / vh
    // Regions of the photo (rU) and of the preview (rP) that show the same content
    val rU: RectF
    val rP: RectF
    if (!fit) {
      rP = RectF(0f, 0f, vw, vh)
      rU = if (av < ai) {
        val fw = up.width * av / ai
        RectF((up.width - fw) / 2, 0f, (up.width + fw) / 2, up.height.toFloat())
      } else {
        val fh = up.height * ai / av
        RectF(0f, (up.height - fh) / 2, up.width.toFloat(), (up.height + fh) / 2)
      }
    } else {
      rU = RectF(0f, 0f, up.width.toFloat(), up.height.toFloat())
      rP = if (av < ai) {
        val ch = vw / ai
        RectF(0f, (vh - ch) / 2, vw, (vh + ch) / 2)
      } else {
        val cw = vh * ai
        RectF((vw - cw) / 2, 0f, (vw + cw) / 2, vh)
      }
    }
    val a = grid(up, inset(rU))
    val p = grid(preview, inset(rP))
    if (up !== raw) up.recycle()
    raw.recycle()
    val flipped = FloatArray(N * N) { i -> a[(i / N) * N + (N - 1 - i % N)] }
    val direct = ncc(a, p)
    val flip = ncc(flipped, p)
    return when {
      direct > flip + 0.1f && direct > 0.35f -> 1
      flip > direct + 0.1f && flip > 0.35f -> 0
      else -> -1
    }
  }

  private fun inset(r: RectF): RectF {
    val dx = r.width() * 0.15f
    val dy = r.height() * 0.15f
    return RectF(r.left + dx, r.top + dy, r.right - dx, r.bottom - dy)
  }

  private fun grid(b: Bitmap, r: RectF): FloatArray {
    val out = FloatArray(N * N)
    for (y in 0 until N) for (x in 0 until N) {
      // average a few pixels per cell
      var acc = 0f
      var n = 0
      for (sy in 0..1) for (sx in 0..1) {
        val px = (r.left + (x + 0.25f + sx * 0.5f) / N * r.width()).toInt().coerceIn(0, b.width - 1)
        val py = (r.top + (y + 0.25f + sy * 0.5f) / N * r.height()).toInt().coerceIn(0, b.height - 1)
        val c = b.getPixel(px, py)
        acc += 0.299f * ((c shr 16) and 0xff) + 0.587f * ((c shr 8) and 0xff) + 0.114f * (c and 0xff)
        n++
      }
      out[y * N + x] = acc / n
    }
    return out
  }

  private fun ncc(a: FloatArray, b: FloatArray): Float {
    val ma = a.average().toFloat()
    val mb = b.average().toFloat()
    var num = 0f
    var da = 0f
    var db = 0f
    for (i in a.indices) {
      val x = a[i] - ma
      val y = b[i] - mb
      num += x * y; da += x * x; db += y * y
    }
    return if (da <= 0f || db <= 0f) 0f else num / sqrt(da * db)
  }
}
