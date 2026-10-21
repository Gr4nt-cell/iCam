package expo.modules.icamera

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Matrix
import android.graphics.Paint
import android.graphics.RectF
import android.media.ExifInterface
import com.google.android.gms.tasks.Tasks
import com.google.mlkit.vision.common.InputImage
import com.google.mlkit.vision.segmentation.Segmentation
import com.google.mlkit.vision.segmentation.selfie.SelfieSegmenterOptions
import com.google.mlkit.vision.segmentation.subject.SubjectSegmentation
import com.google.mlkit.vision.segmentation.subject.SubjectSegmenterOptions
import java.io.File
import java.io.FileOutputStream
import java.util.concurrent.TimeUnit

/**
 * Subject mask for Portrait photos, fully on-device, in three tiers:
 *  1. ML Kit subject segmentation (people, pets, objects – works at any distance)
 *  2. ML Kit selfie segmentation (close-up people)
 *  3. a head-and-shoulders outline built from detected faces
 * Writes a grayscale PNG aligned with the upright photo (white = subject).
 */
object PersonSegmenter {
  private val subject by lazy {
    SubjectSegmentation.getClient(
      SubjectSegmenterOptions.Builder().enableForegroundConfidenceMask().build(),
    )
  }
  private val selfie by lazy {
    Segmentation.getClient(
      SelfieSegmenterOptions.Builder().setDetectorMode(SelfieSegmenterOptions.SINGLE_IMAGE_MODE).build(),
    )
  }

  /** Triggers the Play-services model download early so the first Portrait shot can use it. */
  fun warmUp() {
    try {
      val bmp = Bitmap.createBitmap(64, 64, Bitmap.Config.ARGB_8888)
      Tasks.await(subject.process(InputImage.fromBitmap(bmp, 0)), 20, TimeUnit.SECONDS)
    } catch (_: Throwable) {}
  }

  fun segment(context: Context, path: String): Map<String, Any>? {
    val clean = path.removePrefix("file://")
    val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
    BitmapFactory.decodeFile(clean, bounds)
    if (bounds.outWidth <= 0) return null
    var sample = 1
    while (maxOf(bounds.outWidth, bounds.outHeight) / (sample * 2) >= 1024) sample *= 2
    var bmp = BitmapFactory.decodeFile(clean, BitmapFactory.Options().apply { inSampleSize = sample }) ?: return null
    bmp = upright(bmp, clean)
    val w = bmp.width
    val h = bmp.height
    val input = InputImage.fromBitmap(bmp, 0)

    var source = "subject"
    var mask: FloatArray? = try {
      val r = Tasks.await(subject.process(input), 20, TimeUnit.SECONDS)
      r.foregroundConfidenceMask?.let { fb ->
        fb.rewind()
        FloatArray(w * h) { if (fb.hasRemaining()) fb.get() else 0f }
      }
    } catch (e: Throwable) { null }

    if (mask == null || coverage(mask) < 0.02) {
      source = "selfie"
      mask = try {
        val m = Tasks.await(selfie.process(input), 15, TimeUnit.SECONDS)
        if (m.width == w && m.height == h) {
          val b = m.buffer
          b.rewind()
          FloatArray(w * h) { b.getFloat() }
        } else null
      } catch (e: Throwable) { null }
    }

    var maskBmp: Bitmap? = null
    if (mask != null && coverage(mask) >= 0.02) {
      val px = IntArray(w * h) { i ->
        val c = (mask[i].coerceIn(0f, 1f) * 255f).toInt()
        (0xFF shl 24) or (c shl 16) or (c shl 8) or c
      }
      maskBmp = Bitmap.createBitmap(px, w, h, Bitmap.Config.ARGB_8888)
    } else {
      // Last resort: head-and-shoulders shapes from detected faces
      val faces = FaceFinder.find(path)
      if (faces.isNotEmpty()) {
        source = "faces"
        maskBmp = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888)
        val c = Canvas(maskBmp)
        c.drawColor(Color.BLACK)
        val p = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.WHITE }
        for (f in faces) {
          val fx = (f["x"] ?: 0.0) * w
          val fy = (f["y"] ?: 0.0) * h
          val fw = (f["w"] ?: 0.0) * w
          val fh = (f["h"] ?: 0.0) * h
          c.drawOval(RectF((fx - fw * 0.15).toFloat(), (fy - fh * 0.3).toFloat(), (fx + fw * 1.15).toFloat(), (fy + fh * 1.1).toFloat()), p)
          val cx = fx + fw / 2
          c.drawRoundRect(
            RectF((cx - fw * 1.5).toFloat(), (fy + fh * 0.95).toFloat(), (cx + fw * 1.5).toFloat(), h.toFloat()),
            (fw * 0.8).toFloat(), (fw * 0.8).toFloat(), p,
          )
        }
      }
    }
    bmp.recycle()
    val out = maskBmp ?: return mapOf("maskPath" to "", "width" to 0, "height" to 0, "coverage" to 0.0, "source" to "none")

    var fg = 0
    val sampleStep = 7
    var n = 0
    for (i in 0 until w * h step sampleStep) { if ((out.getPixel(i % w, i / w) and 0xFF) > 128) fg++; n++ }
    val file = File(context.cacheDir, "iCam_mask_${System.currentTimeMillis()}.png")
    FileOutputStream(file).use { out.compress(Bitmap.CompressFormat.PNG, 100, it) }
    out.recycle()
    return mapOf(
      "maskPath" to file.absolutePath,
      "width" to w,
      "height" to h,
      "coverage" to fg.toDouble() / maxOf(1, n),
      "source" to source,
    )
  }

  private fun coverage(m: FloatArray): Double {
    var c = 0
    var n = 0
    for (i in m.indices step 5) { if (m[i] > 0.5f) c++; n++ }
    return c.toDouble() / maxOf(1, n)
  }

  private fun upright(bmp0: Bitmap, path: String): Bitmap {
    val orientation = try {
      ExifInterface(path).getAttributeInt(ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_NORMAL)
    } catch (e: Throwable) { ExifInterface.ORIENTATION_NORMAL }
    val m = Matrix()
    when (orientation) {
      ExifInterface.ORIENTATION_FLIP_HORIZONTAL -> m.setScale(-1f, 1f)
      ExifInterface.ORIENTATION_ROTATE_180 -> m.setRotate(180f)
      ExifInterface.ORIENTATION_FLIP_VERTICAL -> m.setScale(1f, -1f)
      ExifInterface.ORIENTATION_TRANSPOSE -> { m.setRotate(90f); m.postScale(-1f, 1f) }
      ExifInterface.ORIENTATION_ROTATE_90 -> m.setRotate(90f)
      ExifInterface.ORIENTATION_TRANSVERSE -> { m.setRotate(-90f); m.postScale(-1f, 1f) }
      ExifInterface.ORIENTATION_ROTATE_270 -> m.setRotate(-90f)
    }
    if (m.isIdentity) return bmp0
    val r = Bitmap.createBitmap(bmp0, 0, 0, bmp0.width, bmp0.height, m, true)
    if (r !== bmp0) bmp0.recycle()
    return r
  }
}
