package expo.modules.icamera

internal object CaptureOutputPolicy {
  /** Intent thumbnails must stay small enough to fit safely in a Binder result. */
  fun thumbnailSample(width: Int,height: Int): Int {
    var sample=1
    while(maxOf(width,height).toLong()/sample>320 && sample<=Int.MAX_VALUE/2)sample*=2
    return sample
  }
}
