package expo.modules.icamera

import android.app.Activity
import android.app.ActivityOptions
import android.content.Context
import android.content.Intent
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.hardware.display.DisplayManager
import android.os.Bundle
import android.util.TypedValue
import android.view.Display
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import androidx.camera.view.PreviewView
import java.util.concurrent.TimeUnit

/** Connects the back-screen activity with the camera view (same process, main thread). */
object RearBridge {
  var activity: RearScreenActivity? = null
    private set
  /** Called with the back screen's viewfinder when it appears, or null when it closes. */
  var onAttach: ((PreviewView?) -> Unit)? = null
  /** "shutter", "mode", "close", "flip" */
  var onAction: ((String) -> Unit)? = null
  var lastState: Map<String, Any?> = emptyMap()

  fun attach(a: RearScreenActivity) { activity = a; onAttach?.invoke(a.preview) }
  fun detach(a: RearScreenActivity) { if (activity === a) { activity = null; onAttach?.invoke(null) } }
  fun close() { activity?.finish() }
  fun pushState(s: Map<String, Any?>) { lastState = s; activity?.render(s) }
}

/**
 * Opens the camera UI on a phone's back screen (e.g. Xiaomi "rear display" models).
 * 1) A rear / secondary display that apps can see → launch there directly.
 * 2) Otherwise, with root: find the back display id in `dumpsys display` and `am start --display`.
 */
object RearScreen {
  private const val REAR_CATEGORY = "android.hardware.display.category.REAR"

  fun hasRoot(): Boolean = listOf("/system/bin/su", "/system/xbin/su", "/sbin/su", "/su/bin/su", "/debug_ramdisk/su", "/data/adb/ksu/bin/su", "/data/adb/magisk/su")
    .any { java.io.File(it).exists() }

  fun visibleRearDisplay(ctx: Context): Display? {
    val dm = ctx.getSystemService(Context.DISPLAY_SERVICE) as DisplayManager
    val rear = try { dm.getDisplays(REAR_CATEGORY).firstOrNull() } catch (_: Throwable) { null }
    if (rear != null) return rear
    return dm.displays.firstOrNull { it.displayId != Display.DEFAULT_DISPLAY && (it.flags and Display.FLAG_PRESENTATION) == 0 && it.state != Display.STATE_OFF }
  }

  /** Blocking (call off the main thread). Returns null on success, or an error message. */
  fun launch(ctx: Context): String? {
    val intent = Intent(ctx, RearScreenActivity::class.java)
      .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_MULTIPLE_TASK)
    visibleRearDisplay(ctx)?.let { d ->
      return try {
        val opts = ActivityOptions.makeBasic().setLaunchDisplayId(d.displayId)
        ctx.startActivity(intent, opts.toBundle())
        null
      } catch (e: Throwable) {
        if (hasRoot()) rootLaunch(ctx) else "Couldn't open the back screen: ${e.message}"
      }
    }
    if (!hasRoot()) return "No back screen found. On phones like the Xiaomi 17 Pro Max the back screen is only reachable with root access."
    return rootLaunch(ctx)
  }

  private fun su(cmd: String, timeoutSec: Long = 6): Pair<Int, String> {
    val p = ProcessBuilder("su", "-c", cmd).redirectErrorStream(true).start()
    val out = StringBuilder()
    val t = Thread { try { p.inputStream.bufferedReader().forEachLine { out.appendLine(it) } } catch (_: Throwable) {} }
    t.start()
    if (!p.waitFor(timeoutSec, TimeUnit.SECONDS)) { p.destroy(); return -1 to "timed out" }
    t.join(500)
    return p.exitValue() to out.toString()
  }

  private fun rootLaunch(ctx: Context): String? {
    return try {
      val (code, dump) = su("dumpsys display")
      if (code != 0) return "Root access was denied"
      // Collect logical display ids, preferring ones described as rear / back / sub / secondary
      val ids = LinkedHashMap<Int, Int>() // id -> score
      var current = -1
      for (line in dump.lines()) {
        Regex("mDisplayId=(\\d+)").find(line)?.let { current = it.groupValues[1].toInt(); if (current != 0) ids.putIfAbsent(current, 0) }
        if (current > 0) {
          val l = line.lowercase()
          if (listOf("rear", "back", "sub", "secondary", "subscreen").any { l.contains(it) }) ids[current] = (ids[current] ?: 0) + 1
          if (l.contains("virtual") || l.contains("overlay")) ids[current] = (ids[current] ?: 0) - 5
        }
      }
      val target = ids.entries.sortedByDescending { it.value }.firstOrNull()?.key
        ?: return "Root is available, but no back display was found"
      val comp = "${ctx.packageName}/${RearScreenActivity::class.java.name}"
      val (c2, out2) = su("am start --display $target -n $comp")
      if (c2 != 0 || out2.contains("Error")) "Couldn't start on the back screen (display $target): ${out2.trim().take(160)}" else null
    } catch (e: Throwable) {
      "Root command failed: ${e.message}"
    }
  }
}

/** Camera UI shown on the back screen, Xiaomi-style: full-bleed viewfinder, round shutter, mode switch. */
class RearScreenActivity : Activity() {
  lateinit var preview: PreviewView
  private lateinit var shutter: View
  private lateinit var shutterInner: View
  private lateinit var modeText: TextView
  private lateinit var topText: TextView
  private lateinit var countdown: TextView
  private var downX = 0f

  private fun dp(v: Float) = TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v, resources.displayMetrics)

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON or WindowManager.LayoutParams.FLAG_FULLSCREEN)
    val root = FrameLayout(this).apply { setBackgroundColor(Color.BLACK) }
    preview = PreviewView(this).apply {
      implementationMode = PreviewView.ImplementationMode.COMPATIBLE
      scaleType = PreviewView.ScaleType.FILL_CENTER
    }
    root.addView(preview, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))

    // bottom scrim
    root.addView(View(this).apply {
      background = GradientDrawable(GradientDrawable.Orientation.BOTTOM_TOP, intArrayOf(0x99000000.toInt(), 0x00000000))
    }, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(110f).toInt(), Gravity.BOTTOM))

    // top: recording time / hint
    topText = TextView(this).apply {
      setTextColor(Color.WHITE); textSize = 13f; typeface = Typeface.DEFAULT_BOLD
      setPadding(dp(10f).toInt(), dp(3f).toInt(), dp(10f).toInt(), dp(3f).toInt())
      background = GradientDrawable().apply { cornerRadius = dp(12f); setColor(0x55000000) }
      text = "Back screen"
    }
    root.addView(topText, FrameLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.TOP or Gravity.CENTER_HORIZONTAL).apply { topMargin = dp(10f).toInt() })

    countdown = TextView(this).apply {
      setTextColor(Color.WHITE); textSize = 64f; typeface = Typeface.create("sans-serif-thin", Typeface.NORMAL); visibility = View.GONE
    }
    root.addView(countdown, FrameLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.CENTER))

    // bottom row: mode · shutter · close
    val row = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL }
    modeText = TextView(this).apply {
      setTextColor(Color.WHITE); textSize = 12f; typeface = Typeface.DEFAULT_BOLD; letterSpacing = 0.08f
      gravity = Gravity.CENTER
      background = GradientDrawable().apply { cornerRadius = dp(14f); setColor(0x33FFFFFF); setStroke(dp(1f).toInt(), 0x66FFFFFF) }
      setPadding(dp(10f).toInt(), dp(5f).toInt(), dp(10f).toInt(), dp(5f).toInt())
      text = "PHOTO"
      setOnClickListener { RearBridge.onAction?.invoke("mode") }
    }
    val shutterBox = FrameLayout(this)
    shutter = View(this).apply {
      background = GradientDrawable().apply { shape = GradientDrawable.OVAL; setColor(Color.TRANSPARENT); setStroke(dp(3f).toInt(), Color.WHITE) }
    }
    shutterInner = View(this).apply {
      background = GradientDrawable().apply { shape = GradientDrawable.OVAL; setColor(Color.WHITE) }
    }
    shutterBox.addView(shutter, FrameLayout.LayoutParams(dp(62f).toInt(), dp(62f).toInt(), Gravity.CENTER))
    shutterBox.addView(shutterInner, FrameLayout.LayoutParams(dp(50f).toInt(), dp(50f).toInt(), Gravity.CENTER))
    shutterBox.setOnClickListener {
      it.animate().scaleX(0.9f).scaleY(0.9f).setDuration(70).withEndAction { it.animate().scaleX(1f).scaleY(1f).setDuration(90).start() }.start()
      RearBridge.onAction?.invoke("shutter")
    }
    val close = TextView(this).apply {
      setTextColor(Color.WHITE); textSize = 18f; gravity = Gravity.CENTER; text = "⇄"
      background = GradientDrawable().apply { shape = GradientDrawable.OVAL; setColor(0x33FFFFFF) }
      setOnClickListener { RearBridge.onAction?.invoke("close") }
    }
    row.addView(modeText, LinearLayout.LayoutParams(dp(72f).toInt(), ViewGroup.LayoutParams.WRAP_CONTENT))
    row.addView(View(this), LinearLayout.LayoutParams(0, 1, 1f))
    row.addView(shutterBox, LinearLayout.LayoutParams(dp(66f).toInt(), dp(66f).toInt()))
    row.addView(View(this), LinearLayout.LayoutParams(0, 1, 1f))
    row.addView(close, LinearLayout.LayoutParams(dp(40f).toInt(), dp(40f).toInt()).apply { rightMargin = dp(16f).toInt() })
    root.addView(row, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(80f).toInt(), Gravity.BOTTOM).apply {
      leftMargin = dp(12f).toInt(); rightMargin = dp(4f).toInt(); bottomMargin = dp(6f).toInt()
    })

    // swipe left/right on the viewfinder switches Photo / Video, like the Xiaomi back-screen camera
    preview.setOnTouchListener { _, e ->
      when (e.actionMasked) {
        MotionEvent.ACTION_DOWN -> downX = e.x
        MotionEvent.ACTION_UP -> if (Math.abs(e.x - downX) > dp(60f)) RearBridge.onAction?.invoke("mode")
      }
      true
    }
    setContentView(root)
    render(RearBridge.lastState)
    RearBridge.attach(this)
  }

  fun render(s: Map<String, Any?>) {
    if (!::modeText.isInitialized) return
    val video = s["mode"] == "video"
    val recording = s["recording"] == true
    modeText.text = if (video) "VIDEO" else "PHOTO"
    (shutterInner.background as GradientDrawable).apply {
      setColor(if (video) Color.rgb(255, 59, 48) else Color.WHITE)
      cornerRadius = if (recording) dp(8f) else 0f
      shape = if (recording) GradientDrawable.RECTANGLE else GradientDrawable.OVAL
    }
    val inner = if (recording) dp(26f).toInt() else dp(50f).toInt()
    shutterInner.layoutParams = (shutterInner.layoutParams as FrameLayout.LayoutParams).apply { width = inner; height = inner }
    val cd = (s["countdown"] as? Number)?.toInt() ?: 0
    countdown.visibility = if (cd > 0) View.VISIBLE else View.GONE
    countdown.text = cd.toString()
    topText.text = when {
      recording -> "● " + (s["time"] as? String ?: "")
      s["busy"] == true -> "Processing…"
      else -> if (video) "Video · back screen" else "Photo · back screen"
    }
    topText.setTextColor(if (recording) Color.rgb(255, 90, 80) else Color.WHITE)
    preview.scaleX = if (s["mirror"] == true) -1f else 1f
  }

  override fun onDestroy() {
    RearBridge.detach(this)
    super.onDestroy()
  }
}
