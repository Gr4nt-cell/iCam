package expo.modules.icamera

import android.content.Context
import android.graphics.ImageFormat
import android.hardware.camera2.CameraCharacteristics
import android.hardware.camera2.CameraManager
import android.hardware.camera2.CameraMetadata

/**
 * Finds a camera that can shoot macro, from lens data:
 *  - a telephoto that focuses close (≤ ~20 cm, "tele-macro"), preferred for its quality, or
 *  - a dedicated macro camera (focuses ≤ ~8 cm, small sensor/low resolution).
 * Cameras inside a logical multi-camera are reported with their logical parent id.
 */
object MacroFinder {
  data class Macro(val id: String, val parentId: String?, val kind: String, val minFocusCm: Double, val focalEq: Double)

  @Volatile private var cached: Macro? = null
  @Volatile private var done = false

  fun find(ctx: Context): Macro? {
    if (done) return cached
    cached = try { scan(ctx) } catch (e: Throwable) { null }
    done = true
    return cached
  }

  private fun scan(ctx: Context): Macro? {
    val cm = ctx.getSystemService(Context.CAMERA_SERVICE) as CameraManager
    val ids = cm.cameraIdList.toList()
    data class Lens(val id: String, val parent: String?, val minFocus: Float, val eq: Double, val mp: Double, val afMacro: Boolean)
    fun lens(id: String, parent: String?): Lens? {
      val c = cm.getCameraCharacteristics(id)
      if (c.get(CameraCharacteristics.LENS_FACING) != CameraMetadata.LENS_FACING_BACK) return null
      val f = c.get(CameraCharacteristics.LENS_INFO_AVAILABLE_FOCAL_LENGTHS)?.minOrNull() ?: return null
      val sz = c.get(CameraCharacteristics.SENSOR_INFO_PHYSICAL_SIZE) ?: return null
      val minFocus = c.get(CameraCharacteristics.LENS_INFO_MINIMUM_FOCUS_DISTANCE) ?: 0f
      val diag = Math.hypot(sz.width.toDouble(), sz.height.toDouble())
      val px = c.get(CameraCharacteristics.SCALER_STREAM_CONFIGURATION_MAP)?.getOutputSizes(ImageFormat.JPEG)
        ?.maxOfOrNull { it.width.toLong() * it.height } ?: 0L
      val af = c.get(CameraCharacteristics.CONTROL_AF_AVAILABLE_MODES)?.contains(CameraMetadata.CONTROL_AF_MODE_MACRO) == true
      return Lens(id, parent, minFocus, if (diag > 0) f * 43.27 / diag else 0.0, px / 1e6, af)
    }
    val all = ArrayList<Lens>()
    val mainId = ids.firstOrNull { cm.getCameraCharacteristics(it).get(CameraCharacteristics.LENS_FACING) == CameraMetadata.LENS_FACING_BACK }
    for (id in ids) {
      lens(id, null)?.let { all.add(it) }
      if (android.os.Build.VERSION.SDK_INT >= 28) {
        try {
          for (p in cm.getCameraCharacteristics(id).physicalCameraIds) if (all.none { it.id == p }) lens(p, id)?.let { all.add(it) }
        } catch (_: Throwable) {}
      }
    }
    val mainEq = all.firstOrNull { it.id == mainId }?.eq?.takeIf { it > 0 } ?: all.minByOrNull { Math.abs(it.eq - 26) }?.eq ?: 26.0
    // Tele-macro: ≥1.8× the main lens and focuses at 20 cm or closer (minFocus in diopters = 1/m)
    val tele = all.filter { it.eq >= mainEq * 1.8 && it.minFocus >= 5f }.maxByOrNull { it.minFocus }
    if (tele != null) return Macro(tele.id, tele.parent, "tele", 100.0 / tele.minFocus, tele.eq)
    // Dedicated macro: focuses at ~8 cm or closer and is a small (≤ 8 MP) camera, not the main one
    val macro = all.filter { it.id != mainId && it.minFocus >= 12f && it.mp in 0.5..8.5 }.maxByOrNull { it.minFocus }
    if (macro != null) return Macro(macro.id, macro.parent, "dedicated", 100.0 / macro.minFocus, macro.eq)
    return null
  }
}
