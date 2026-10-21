package expo.modules.icamera

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Matrix
import android.graphics.PointF
import android.media.ExifInterface
import android.media.FaceDetector

/**
 * Finds faces with Android's built-in on-device detector so exposure can prioritise people
 * (e.g. a subject standing in front of a bright window). Boxes are normalized 0..1 on the
 * upright image.
 */
object FaceFinder {
  fun find(path: String): List<Map<String, Double>> {
    val clean = path.removePrefix("file://")
    val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
    BitmapFactory.decodeFile(clean, bounds)
    if (bounds.outWidth <= 0) return emptyList()

    // Decode small (≈800 px) – plenty for face detection and fast
    var sample = 1
    while (maxOf(bounds.outWidth, bounds.outHeight) / (sample * 2) >= 800) sample *= 2
    val opts = BitmapFactory.Options().apply {
      inSampleSize = sample
      inPreferredConfig = Bitmap.Config.RGB_565
    }
    var bmp = BitmapFactory.decodeFile(clean, opts) ?: return emptyList()

    // Apply EXIF orientation so boxes match the upright photo
    val orientation = try {
      ExifInterface(clean).getAttributeInt(ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_NORMAL)
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
    if (!m.isIdentity) {
      val rotated = Bitmap.createBitmap(bmp, 0, 0, bmp.width, bmp.height, m, true)
      if (rotated !== bmp) bmp.recycle()
      bmp = rotated
    }
    // FaceDetector needs RGB_565 and an even width
    if (bmp.config != Bitmap.Config.RGB_565 || bmp.width % 2 != 0) {
      val w = bmp.width - (bmp.width % 2)
      val conv = Bitmap.createBitmap(w, bmp.height, Bitmap.Config.RGB_565)
      android.graphics.Canvas(conv).drawBitmap(bmp, 0f, 0f, null)
      bmp.recycle()
      bmp = conv
    }

    val faces = arrayOfNulls<FaceDetector.Face>(5)
    val count = try { FaceDetector(bmp.width, bmp.height, faces.size).findFaces(bmp, faces) } catch (e: Throwable) { 0 }
    val w = bmp.width.toDouble()
    val h = bmp.height.toDouble()
    val out = ArrayList<Map<String, Double>>()
    val mid = PointF()
    for (i in 0 until count) {
      val f = faces[i] ?: continue
      if (f.confidence() < 0.3f) continue
      f.getMidPoint(mid)
      val eyes = f.eyesDistance().toDouble()
      // Face box ≈ 2.2 × eye distance wide, 2.6 × tall, centred slightly below the eyes
      val bw = eyes * 2.2
      val bh = eyes * 2.6
      val cx = mid.x.toDouble()
      val cy = mid.y + eyes * 0.35
      out.add(
        mapOf(
          "x" to ((cx - bw / 2) / w).coerceIn(0.0, 1.0),
          "y" to ((cy - bh / 2) / h).coerceIn(0.0, 1.0),
          "w" to (bw / w).coerceIn(0.0, 1.0),
          "h" to (bh / h).coerceIn(0.0, 1.0),
          "confidence" to f.confidence().toDouble(),
        ),
      )
    }
    bmp.recycle()
    return out
  }
}
