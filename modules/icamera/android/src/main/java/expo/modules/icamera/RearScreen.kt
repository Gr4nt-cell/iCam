package expo.modules.icamera

import android.app.Presentation
import android.content.Context
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.hardware.display.DisplayManager
import android.os.Bundle
import android.util.TypedValue
import android.view.Display
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import androidx.camera.view.PreviewView

/** Finds displays other than the main one that apps are allowed to draw on (e.g. a rear/back screen). */
object RearDisplays {
  fun list(context: Context): List<Display> {
    val dm = context.getSystemService(Context.DISPLAY_SERVICE) as DisplayManager
    return dm.displays.filter { it.displayId != Display.DEFAULT_DISPLAY && it.isValid }
  }

  fun describe(context: Context): List<Map<String, Any?>> = list(context).map { d ->
    val m = android.util.DisplayMetrics()
    @Suppress("DEPRECATION")
    d.getRealMetrics(m)
    mapOf(
      "id" to d.displayId,
      "name" to d.name,
      "width" to m.widthPixels,
      "height" to m.heightPixels,
      "presentation" to ((d.flags and Display.FLAG_PRESENTATION) != 0),
    )
  }
}

/**
 * Back-screen camera UI, styled after Xiaomi's rear-display viewfinder:
 * edge-to-edge preview, a compact shutter, Photo/Video and zoom toggles, and a button to return
 * to the main screen. All actions are forwarded to JS through [onAction].
 */
class RearScreenPresentation(
  context: Context,
  display: Display,
  private val onAction: (String) -> Unit,
) : Presentation(context, display) {

  lateinit var previewView: PreviewView
    private set

  private lateinit var shutterInner: View
  private lateinit var modeLabel: TextView
  private lateinit var zoomLabel: TextView
  private lateinit var timerLabel: TextView
  private lateinit var countdownLabel: TextView

  private fun dp(v: Float) = TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v, context.resources.displayMetrics)

  private fun glass(radius: Float) = GradientDrawable().apply {
    shape = GradientDrawable.RECTANGLE
    cornerRadius = radius
    setColor(Color.argb(46, 255, 255, 255))
    setStroke(dp(1f).toInt(), Color.argb(110, 255, 255, 255))
  }

  private fun pill(text: String, action: String) = TextView(context).apply {
    this.text = text
    setTextColor(Color.WHITE)
    setTextSize(TypedValue.COMPLEX_UNIT_SP, 13f)
    typeface = Typeface.DEFAULT_BOLD
    gravity = Gravity.CENTER
    background = glass(dp(18f))
    setPadding(dp(12f).toInt(), 0, dp(12f).toInt(), 0)
    minWidth = dp(44f).toInt()
    setShadowLayer(4f, 0f, 1f, Color.argb(120, 0, 0, 0))
    setOnClickListener { onAction(action) }
  }

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    val root = FrameLayout(context).apply { setBackgroundColor(Color.BLACK) }

    previewView = PreviewView(context).apply {
      implementationMode = PreviewView.ImplementationMode.COMPATIBLE
      scaleType = PreviewView.ScaleType.FILL_CENTER
    }
    root.addView(previewView, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))

    // Tap anywhere on the preview = shutter (how the rear viewfinder is usually triggered)
    previewView.setOnClickListener { onAction("shutter") }

    timerLabel = TextView(context).apply {
      setTextColor(Color.WHITE)
      setTextSize(TypedValue.COMPLEX_UNIT_SP, 13f)
      typeface = Typeface.DEFAULT_BOLD
      background = GradientDrawable().apply { cornerRadius = dp(12f); setColor(Color.argb(170, 255, 59, 48)) }
      setPadding(dp(10f).toInt(), dp(3f).toInt(), dp(10f).toInt(), dp(3f).toInt())
      visibility = View.GONE
    }
    root.addView(timerLabel, FrameLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.TOP or Gravity.CENTER_HORIZONTAL).apply { topMargin = dp(10f).toInt() })

    countdownLabel = TextView(context).apply {
      setTextColor(Color.WHITE)
      setTextSize(TypedValue.COMPLEX_UNIT_SP, 64f)
      typeface = Typeface.create("sans-serif-light", Typeface.NORMAL)
      setShadowLayer(10f, 0f, 2f, Color.argb(160, 0, 0, 0))
      visibility = View.GONE
    }
    root.addView(countdownLabel, FrameLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.CENTER))

    val exit = pill("⇆ Main", "exit")
    root.addView(exit, FrameLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, dp(34f).toInt(), Gravity.TOP or Gravity.END).apply {
      topMargin = dp(10f).toInt(); marginEnd = dp(10f).toInt()
    })

    // Bottom bar: [mode]  (shutter)  [zoom]
    val bar = LinearLayout(context).apply {
      orientation = LinearLayout.HORIZONTAL
      gravity = Gravity.CENTER_VERTICAL
    }
    modeLabel = pill("PHOTO", "mode")
    zoomLabel = pill("1×", "zoom")

    val shutter = FrameLayout(context).apply {
      background = GradientDrawable().apply {
        shape = GradientDrawable.OVAL
        setColor(Color.argb(40, 255, 255, 255))
        setStroke(dp(3f).toInt(), Color.WHITE)
      }
      setOnClickListener { onAction("shutter") }
    }
    shutterInner = View(context).apply {
      background = GradientDrawable().apply { shape = GradientDrawable.OVAL; setColor(Color.WHITE) }
    }
    shutter.addView(shutterInner, FrameLayout.LayoutParams(dp(42f).toInt(), dp(42f).toInt(), Gravity.CENTER))

    val side = dp(20f).toInt()
    bar.addView(modeLabel, LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, dp(34f).toInt()))
    bar.addView(View(context), LinearLayout.LayoutParams(side, 1))
    bar.addView(shutter, LinearLayout.LayoutParams(dp(58f).toInt(), dp(58f).toInt()))
    bar.addView(View(context), LinearLayout.LayoutParams(side, 1))
    bar.addView(zoomLabel, LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, dp(34f).toInt()))

    root.addView(bar, FrameLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.BOTTOM or Gravity.CENTER_HORIZONTAL).apply {
      bottomMargin = dp(12f).toInt()
    })

    setContentView(root)
  }

  /** Mirrors the main app's state onto the back screen. */
  fun update(state: Map<String, Any?>) {
    if (!::modeLabel.isInitialized) return
    val video = state["mode"] == "video"
    val recording = state["recording"] == true
    modeLabel.text = if (video) "VIDEO" else "PHOTO"
    zoomLabel.text = "${state["zoom"] ?: "1"}×"

    val inner = shutterInner.background as GradientDrawable
    val lp = shutterInner.layoutParams
    if (video && recording) {
      inner.shape = GradientDrawable.RECTANGLE
      inner.cornerRadius = dp(6f)
      inner.setColor(Color.rgb(255, 59, 48))
      lp.width = dp(22f).toInt(); lp.height = dp(22f).toInt()
    } else {
      inner.shape = GradientDrawable.OVAL
      inner.setColor(if (video) Color.rgb(255, 59, 48) else Color.WHITE)
      lp.width = dp(42f).toInt(); lp.height = dp(42f).toInt()
    }
    shutterInner.layoutParams = lp

    val seconds = (state["seconds"] as? Number)?.toInt() ?: 0
    timerLabel.visibility = if (recording) View.VISIBLE else View.GONE
    timerLabel.text = String.format("%02d:%02d", seconds / 60, seconds % 60)

    val countdown = (state["countdown"] as? Number)?.toInt() ?: 0
    countdownLabel.visibility = if (countdown > 0) View.VISIBLE else View.GONE
    countdownLabel.text = countdown.toString()
  }
}
