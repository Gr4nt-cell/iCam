package expo.modules.icamera

internal object UiRefreshPolicy {
  fun target(rates: List<Float>): Float {
    val usable=rates.filter{it.isFinite()&&it>=30f}
    return usable.filter{it<=120.5f}.maxOrNull()?.coerceAtMost(120f)
      ?: usable.maxOrNull()?.coerceAtMost(120f) ?: 60f
  }
}
