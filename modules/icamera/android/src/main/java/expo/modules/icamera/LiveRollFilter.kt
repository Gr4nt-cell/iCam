package expo.modules.icamera

import kotlin.math.*

/** Causal roll correction. No recorded frames or whole-clip analysis are retained. */
internal class LiveRollFilter {
  private var initialized=false
  private var last=0.0
  private var unwrapped=0.0
  private var baseline=0.0
  private var reference=0.0
  private var leveled=0.0
  fun reset(){initialized=false}
  fun update(raw: Float,seconds: Double,horizon: Boolean,maxTremor: Float): Float {
    if(!raw.isFinite() || !seconds.isFinite())return 0f
    if(!initialized || seconds>.3){
      initialized=true;last=raw.toDouble();unwrapped=last;baseline=last
      reference=round(last/(PI/2))*(PI/2);leveled=last-reference
    }else{
      var delta=raw-last
      while(delta>PI)delta-=2*PI
      while(delta< -PI)delta+=2*PI
      if(abs(delta)>1.0){reset();return update(raw,seconds,horizon,maxTremor)}
      unwrapped+=delta;last=raw.toDouble()
    }
    val dt=seconds.coerceIn(.005,.1)
    baseline+=(unwrapped-baseline)*(1-exp(-dt/.45))
    leveled+=(unwrapped-reference-leveled)*(1-exp(-dt/.035))
    return if(horizon)leveled.toFloat() else (unwrapped-baseline).toFloat().coerceIn(-maxTremor,maxTremor)
  }
}
