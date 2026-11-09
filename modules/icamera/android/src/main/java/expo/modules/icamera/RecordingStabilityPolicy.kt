package expo.modules.icamera

import kotlin.math.exp
import kotlin.math.max

internal data class RecordingStabilityPlan(val preview: Boolean, val video: Boolean, val software: Boolean) {
  val hardware get()=preview||video
}

internal object RecordingStabilityPolicy {
  fun deliveryStalled(activeDurationNanos:Long,frames:Long):Boolean = activeDurationNanos>2_000_000_000L && frames<=0L
  fun select(enabled:Boolean,explicitHorizon:Boolean,sharedSupported:Boolean,videoSupported:Boolean,hdr:Boolean):RecordingStabilityPlan {
    if(!enabled)return RecordingStabilityPlan(false,false,false)
    if(!explicitHorizon&&sharedSupported)return RecordingStabilityPlan(true,false,false)
    // Video-only EIS may not apply to the SurfaceTexture feeding a custom SDR effect.
    if(hdr)return RecordingStabilityPlan(false,videoSupported,false)
    return RecordingStabilityPlan(false,false,true)
  }
}

/** One envelope per camera frame, including when the encoder surface joins a warm preview. */
internal class RecordingCropEnvelope {
  private var crop=1f
  private var hold=0.0
  fun reset(){crop=1f;hold=0.0}
  fun update(required:Float,seconds:Double,horizon:Boolean):Float {
    val needed=max(1f,required)
    if(!horizon){crop=needed;hold=0.0;return crop}
    val dt=seconds.coerceIn(0.0,.1)
    if(needed>=crop){crop=needed;hold=.5}
    else{hold-=dt;if(hold<=0)crop=max(needed,(needed+(crop-needed)*exp(-dt/1.2)).toFloat())}
    return crop
  }
}
