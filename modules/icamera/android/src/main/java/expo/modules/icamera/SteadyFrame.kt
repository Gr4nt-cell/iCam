package expo.modules.icamera

import kotlin.math.*

internal data class CaptureStabilityPlan(val preview: Boolean, val video: Boolean) {
  val hardware get() = preview || video
}

/** A single, fixed software margin. Hardware EIS never gets a second software crop. */
internal object CaptureStability {
  fun crop(mode: String, setting: String, front: Boolean = false, hardware: Boolean = false): Float = when {
    hardware || (mode != "action" && setting == "off") -> 1f
    setting == "horizon" -> if (front) 1.06f else 1.10f
    mode == "action" -> if (front) 1.08f else 1.12f
    setting == "cinematic" -> if (front) 1.05f else 1.08f
    else -> 1.04f
  }
  fun horizon(mode: String, setting: String) = setting == "horizon"
  fun plan(enabled: Boolean, horizon: Boolean, shared: Boolean, video: Boolean, hdr: Boolean) = when {
    !enabled || horizon -> CaptureStabilityPlan(false, false)
    shared -> CaptureStabilityPlan(true, false)
    hdr -> CaptureStabilityPlan(false, video)
    else -> CaptureStabilityPlan(false, false)
  }
  fun deliveryStalled(nanos: Long, frames: Long) = nanos > 2_000_000_000L && frames <= 0L
  fun frameRate(ranges: List<Pair<Int, Int>>, target: Int): Pair<Int, Int>? =
    ranges.firstOrNull { it.first == target && it.second == target }
      ?: ranges.filter { it.second == target }.maxByOrNull { it.first }
      ?: ranges.minWithOrNull(compareBy<Pair<Int, Int>> { abs(it.second - target) }.thenBy { it.second - it.first })
}

internal data class FrameTranslation(val x: Double, val y: Double, val confidence: Double)

/** Grid-distributed corner patches, a two-level pyramid, exposure-normalised SSD and round-trip checks. */
internal object PyramidTranslation {
  private fun half(a: IntArray, w: Int, h: Int): IntArray = IntArray(w / 2 * (h / 2)) { i ->
    val x = i % (w / 2) * 2; val y = i / (w / 2) * 2
    (a[y*w+x] + a[y*w+x+1] + a[(y+1)*w+x] + a[(y+1)*w+x+1]) / 4
  }
  private fun cost(a: IntArray, b: IntArray, w: Int, h: Int, x: Int, y: Int, dx: Int, dy: Int): Double {
    if (x-2<0 || y-2<0 || x+2>=w || y+2>=h || x+dx-2<0 || y+dy-2<0 || x+dx+2>=w || y+dy+2>=h) return Double.POSITIVE_INFINITY
    var sum = 0.0; var square = 0.0
    for (yy in -2..2) for (xx in -2..2) {
      val d = b[(y+dy+yy)*w+x+dx+xx] - a[(y+yy)*w+x+xx]
      sum += d; square += d*d
    }
    return max(0.0, (square - sum*sum/25) / 25)
  }
  private fun search(a: IntArray, b: IntArray, w: Int, h: Int, x: Int, y: Int, cx: Int, cy: Int, radius: Int): Triple<Int,Int,Double> {
    var bx=cx; var by=cy; var best=Double.POSITIVE_INFINITY
    for (dy in cy-radius..cy+radius) for (dx in cx-radius..cx+radius) {
      val v=cost(a,b,w,h,x,y,dx,dy)
      if(v<best){best=v;bx=dx;by=dy}
    }
    return Triple(bx,by,best)
  }
  fun measure(previous: IntArray, current: IntArray, width: Int, height: Int): FrameTranslation? {
    if (width<80 || height<48 || width%2!=0 || height%2!=0 || previous.size!=width*height || current.size!=previous.size) return null
    val pa=half(previous,width,height); val pb=half(current,width,height)
    val tracks=ArrayList<Pair<Double,Double>>()
    for (gy in 0..3) for (gx in 0..5) {
      val x0=12+gx*(width-24)/6; val y0=12+gy*(height-24)/4
      val x1=12+(gx+1)*(width-24)/6; val y1=12+(gy+1)*(height-24)/4
      var bx=x0; var by=y0; var score=180.0
      for(y in y0 until y1 step 2) for(x in x0 until x1 step 2) {
        var xx=0.0;var yy=0.0;var xy=0.0
        for(j in -1..1) for(i in -1..1){
          val k=(y+j)*width+x+i
          val dx=previous[k+1]-previous[k-1];val dy=previous[k+width]-previous[k-width]
          xx+=dx*dx;yy+=dy*dy;xy+=dx*dy
        }
        val corner=(xx+yy-sqrt((xx-yy).pow(2)+4*xy*xy))/2
        if(corner>score){score=corner;bx=x;by=y}
      }
      if(score<=180)continue
      val coarse=search(pa,pb,width/2,height/2,bx/2,by/2,0,0,4)
      val fine=search(previous,current,width,height,bx,by,coarse.first*2,coarse.second*2,2)
      if(!fine.third.isFinite() || fine.third>500 || abs(fine.first)>=10 || abs(fine.second)>=10)continue
      val reverse=search(current,previous,width,height,bx+fine.first,by+fine.second,-fine.first,-fine.second,2)
      if(hypot((fine.first+reverse.first).toDouble(),(fine.second+reverse.second).toDouble())>1.1)continue
      fun sub(axisX: Boolean): Double {
        val minus=cost(previous,current,width,height,bx,by,fine.first-if(axisX)1 else 0,fine.second-if(axisX)0 else 1)
        val plus=cost(previous,current,width,height,bx,by,fine.first+if(axisX)1 else 0,fine.second+if(axisX)0 else 1)
        val curvature=minus-2*fine.third+plus
        return if(fine.third>.001 && curvature.isFinite() && curvature>0.01) (0.5*(minus-plus)/curvature).coerceIn(-.5,.5) else 0.0
      }
      tracks.add(fine.first+sub(true) to fine.second+sub(false))
    }
    if(tracks.size<5)return null
    // A moving person/foreground patch cannot win by one very strong feature alone.
    val seed=tracks.maxByOrNull { a -> tracks.count { b -> hypot(a.first-b.first,a.second-b.second)<1.25 } }!!
    val inliers=tracks.filter { hypot(it.first-seed.first,it.second-seed.second)<1.25 }
    if(inliers.size<5 || inliers.size.toDouble()/tracks.size<.55)return null
    return FrameTranslation(inliers.map{it.first}.average()/width,inliers.map{it.second}.average()/height,inliers.size.toDouble()/24)
  }
}

internal data class SteadyTransform(val x: Float=0f, val y: Float=0f, val angle: Float=0f, val crop: Float=1f)

/** Current-frame causal path controller. No delayed picture, cumulative drift, or changing zoom envelope. */
internal class SteadyFrame {
  private var previous: IntArray?=null
  private var timestamp=0L
  private var x=0.0;private var y=0.0
  private var vx=0.0;private var vy=0.0
  private var rollReady=false
  private var lastRoll=0.0;private var roll=0.0;private var rollBase=0.0;private var reference=0.0
  private var oldWidth=0;private var oldHeight=0
  var lastConfidence=0.0
    private set
  fun reset(){previous=null;timestamp=0L;x=0.0;y=0.0;vx=0.0;vy=0.0;rollReady=false;lastConfidence=0.0}
  fun update(luma: IntArray?, width: Int, height: Int, nanos: Long, crop: Float, rawRoll: Float, horizon: Boolean,
    sensorAspect: Float=width.toFloat()/height): SteadyTransform {
    if(width!=oldWidth || height!=oldHeight){reset();oldWidth=width;oldHeight=height}
    val dt=if(timestamp>0) (nanos-timestamp)/1e9 else 0.0
    if(timestamp>0 && (dt<=0 || dt>.2))reset()
    timestamp=nanos
    val seconds=if(dt in .001.. .2)dt else 1.0/30
    if(crop<=1f){previous=null;x=0.0;y=0.0;rollReady=false;return SteadyTransform()}
    val motion=if(luma!=null && previous!=null)PyramidTranslation.measure(previous!!,luma,width,height)else null
    previous=luma
    lastConfidence=motion?.confidence ?: 0.0
    // Follow the low-frequency pan velocity; reserve the crop for high-frequency shake.
    val panBlend=1-exp(-seconds/.35)
    if(motion!=null){
      vx+=(motion.x/seconds-vx)*panBlend;vy+=(motion.y/seconds-vy)*panBlend
      x+=motion.x-vx*seconds;y+=motion.y-vy*seconds
    }else{vx*=exp(-seconds/.12);vy*=exp(-seconds/.12)}
    val decay=exp(-seconds/if(motion==null).09 else .8)
    x*=decay;y*=decay
    var correction=0.0
    if(rawRoll.isFinite()){
      if(!rollReady){lastRoll=rawRoll.toDouble();roll=lastRoll;rollBase=roll;reference=round(roll/(PI/2))*(PI/2);rollReady=true}
      else {
        val delta=atan2(sin(rawRoll-lastRoll),cos(rawRoll-lastRoll))
        if(abs(delta)<.7)roll+=delta else{roll=rawRoll.toDouble();rollBase=roll;reference=round(roll/(PI/2))*(PI/2)}
        lastRoll=rawRoll.toDouble()
      }
      rollBase+=(roll-rollBase)*(1-exp(-seconds/.45))
      correction=if(horizon)roll-reference else roll-rollBase
    }
    val aspect=sensorAspect.toDouble().coerceIn(.2,5.0)
    // Normal modes spend at most a quarter of their margin on roll. Never stack a second zoom.
    if(!horizon){
      val maxAngle=(crop-1.0)/(max(aspect,1/aspect)*4)
      correction=correction.coerceIn(-maxAngle,maxAngle)
    }
    val c=abs(cos(correction));val s=abs(sin(correction))
    val lx=max(0.0,.5-(c+s/aspect)/(2*crop)-.001)
    val ly=max(0.0,.5-(c+s*aspect)/(2*crop)-.001)
    fun soft(value: Double, limit: Double) = if(limit<=0)0.0 else limit*tanh(value/limit)
    // Smooth pan pressure well before a hard boundary; state is also bounded to prevent wind-up.
    x=x.coerceIn(-max(lx,.001)*2,max(lx,.001)*2)
    y=y.coerceIn(-max(ly,.001)*2,max(ly,.001)*2)
    return SteadyTransform(soft(x,lx).toFloat(),soft(y,ly).toFloat(),correction.toFloat(),crop)
  }
}
