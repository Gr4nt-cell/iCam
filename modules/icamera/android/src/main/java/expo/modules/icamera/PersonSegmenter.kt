package expo.modules.icamera

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Matrix
import android.media.ExifInterface
import com.google.android.gms.tasks.Tasks
import com.google.mlkit.vision.common.InputImage
import com.google.mlkit.vision.segmentation.Segmentation
import com.google.mlkit.vision.segmentation.selfie.SelfieSegmenterOptions
import java.io.File
import java.io.FileOutputStream
import java.util.concurrent.TimeUnit

/**
 * Person segmentation for Portrait photos (ML Kit selfie segmenter, fully on-device).
 * Writes the foreground mask as a grayscale PNG aligned with the upright photo.
 */
object PersonSegmenter {
  private val segmenter by lazy {
    Segmentation.getClient(
      SelfieSegmenterOptions.Builder()
        .setDetectorMode(SelfieSegmenterOptions.SINGLE_IMAGE_MODE)
        .build(),
    )
  }

  fun segment(context: Context, path: String): Map<String, Any>? {
    val clean = path.removePrefix("file://")
    val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
    BitmapFactory.decodeFile(clean, bounds)
    if (bounds.outWidth <= 0) return null
    var sample = 1
    while (maxOf(bounds.outWidth, bounds.outHeight) / (sample * 2) >= 768) sample *= 2
    var bmp = BitmapFactory.decodeFile(clean, BitmapFactory.Options().apply { inSampleSize = sample }) ?: return null

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
      val r = Bitmap.createBitmap(bmp, 0, 0, bmp.width, bmp.height, m, true)
      if (r !== bmp) bmp.recycle()
      bmp = r
    }

    val mask = Tasks.await(segmenter.process(InputImage.fromBitmap(bmp, 0)), 15, TimeUnit.SECONDS)
    val mw = mask.width
    val mh = mask.height
    val buf = mask.buffer
    buf.rewind()
    val pixels = IntArray(mw * mh)
    var fg = 0
    for (i in 0 until mw * mh) {
      val c = (buf.getFloat().coerceIn(0f, 1f) * 255f).toInt()
      if (c > 128) fg++
      pixels[i] = (0xFF shl 24) or (c shl 16) or (c shl 8) or c
    }
    bmp.recycle()
    val out = Bitmap.createBitmap(pixels, mw, mh, Bitmap.Config.ARGB_8888)
    val file = File(context.cacheDir, "iCam_mask_${System.currentTimeMillis()}.png")
    FileOutputStream(file).use { out.compress(Bitmap.CompressFormat.PNG, 100, it) }
    out.recycle()
    return mapOf(
      "maskPath" to file.absolutePath,
      "width" to mw,
      "height" to mh,
      "coverage" to fg.toDouble() / (mw * mh),
    )
  }
}
