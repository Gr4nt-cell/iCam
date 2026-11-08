package expo.modules.icamera

import kotlin.math.*

internal data class FrameMotion(val x: Double, val y: Double, val angle: Double, val reliable: Boolean)
internal data class CameraPose(val timeUs: Long, val x: Double, val y: Double, val angle: Double, val cut: Boolean = false)

/** Sparse multi-scale patch tracking. No full-resolution readback or native CV dependency. */
internal object OfflineVideoMotion {
  private data class Match(val x: Double, val y: Double, val u: Double, val v: Double)
  fun estimate(previous: IntArray, current: IntArray, width: Int, height: Int): FrameMotion {
    require(previous.size == width * height && current.size == previous.size)
    if (width < 80 || height < 80) return FrameMotion(0.0,0.0,0.0,false)
    val prevPyramid=pyramid(previous,width,height);val curPyramid=pyramid(current,width,height)
    val matches = ArrayList<Match>()
    val margin = 36
    // Select a corner within each tile rather than sampling flat grid centres.
    // Wide spatial coverage prevents a moving face from monopolizing all tracks.
    val columns=5;val rows=if(height>width)8 else 5
    for (row in 0 until rows) for (col in 0 until columns) {
      val left=margin+col*(width-2*margin)/columns
      val right=margin+(col+1)*(width-2*margin)/columns
      val top=margin+row*(height-2*margin)/rows
      val bottom=margin+(row+1)*(height-2*margin)/rows
      var x=left;var y=top;var bestCorner=0.0
      for(py in top until max(top+1,bottom) step 3)for(px in left until max(left+1,right) step 3){
        var xx=0.0;var yy=0.0;var xy=0.0
        for(j in -4..4 step 2)for(i in -4..4 step 2){val p=(py+j)*width+px+i;val gx=(previous[p+1]-previous[p-1]).toDouble();val gy=(previous[p+width]-previous[p-width]).toDouble();xx+=gx*gx;yy+=gy*gy;xy+=gx*gy}
        val score=(xx+yy-sqrt((xx-yy).pow(2)+4*xy*xy))*.5
        if(score>bestCorner){bestCorner=score;x=px;y=py}
      }
      if(bestCorner<150)continue
      var sum = 0.0; var sum2 = 0.0; var gx = 0.0; var gy = 0.0; var cross = 0.0
      for (j in -7..7 step 2) for (i in -7..7 step 2) {
        val p = (y+j)*width+x+i; val v=previous[p].toDouble(); sum+=v; sum2+=v*v
        val dx=(previous[p+1]-previous[p-1]).toDouble(); val dy=(previous[p+width]-previous[p-width]).toDouble()
        gx+=dx*dx;gy+=dy*dy;cross+=dx*dy
      }
      if (sum2/64 - (sum/64).pow(2) < 25 || min(gx,gy) < 350 || gx*gy-cross*cross < (gx+gy).pow(2)*.015) continue
      val tracked=track(prevPyramid,curPyramid,x.toDouble(),y.toDouble()) ?: continue
      val reverse=track(curPyramid,prevPyramid,x+tracked[0],y+tracked[1]) ?: continue
      if(hypot(tracked[0]+reverse[0],tracked[1]+reverse[1])>.8)continue
      matches.add(Match(x-width/2.0,y-height/2.0,x+tracked[0]-width/2.0,y+tracked[1]-height/2.0))
    }
    if(matches.size<5)return FrameMotion(0.0,0.0,0.0,false)
    var winner=emptyList<Match>();var bestError=Double.MAX_VALUE
    fun fit(points: List<Match>): DoubleArray? {
      val matrix=Array(3){DoubleArray(5)}
      for(p in points){val q=doubleArrayOf(p.x,p.y,1.0)
        for(i in 0..2){for(j in 0..2)matrix[i][j]+=q[i]*q[j];matrix[i][3]+=q[i]*p.u;matrix[i][4]+=q[i]*p.v}}
      for(i in 0..2){val pivot=(i..2).maxByOrNull{abs(matrix[it][i])}!!
        if(abs(matrix[pivot][i])<1e-6)return null
        val temp=matrix[i];matrix[i]=matrix[pivot];matrix[pivot]=temp
        val d=matrix[i][i];for(j in i..4)matrix[i][j]/=d
        for(k in 0..2)if(k!=i){val f=matrix[k][i];for(j in i..4)matrix[k][j]-=f*matrix[i][j]}}
      return doubleArrayOf(matrix[0][3],matrix[1][3],matrix[2][3],matrix[0][4],matrix[1][4],matrix[2][4])
    }
    // Affine consensus tolerates perspective-induced shear during pans. Only its rigid
    // centre motion / polar rotation is stabilized, avoiding rubbery frame deformation.
    val random=kotlin.random.Random(319)
    repeat(300){
      val ids=(0..2).map{random.nextInt(matches.size)}
      if(ids.toSet().size<3)return@repeat
      val m=fit(ids.map{matches[it]}) ?: return@repeat
      val det=m[0]*m[4]-m[1]*m[3]
      if(det !in .85..1.15 || abs(m[1])>.16 || abs(m[3])>.16)return@repeat
      val errors=matches.map{hypot(it.u-(m[0]*it.x+m[1]*it.y+m[2]),it.v-(m[3]*it.x+m[4]*it.y+m[5]))}
      val inside=matches.filterIndexed{k,_->errors[k]<1.4};val error=errors.filter{it<1.4}.sum()
      if(inside.size>winner.size||inside.size==winner.size&&error<bestError){winner=inside;bestError=error}
    }
    if(winner.size<max(5,(matches.size+1)/2))return FrameMotion(0.0,0.0,0.0,false)
    val m=fit(winner) ?: return FrameMotion(0.0,0.0,0.0,false)
    return FrameMotion(m[2],m[5],atan2(m[3]-m[1],m[0]+m[4]),true)
  }

  private data class Level(val pixels: IntArray,val width: Int,val height: Int)
  private fun pyramid(input: IntArray,width: Int,height: Int): List<Level> {
    val result=ArrayList<Level>();var image=input;var w=width;var h=height
    repeat(3){level->
      result.add(Level(image,w,h))
      if(level<2){val nw=w/2;val nh=h/2;val reduced=IntArray(nw*nh)
        for(y in 0 until nh)for(x in 0 until nw){val px=x*2;val py=y*2;var sum=0;var weight=0
          for(j in -1..1)for(i in -1..1){val k=(if(i==0)2 else 1)*(if(j==0)2 else 1);sum+=image[(py+j).coerceIn(0,h-1)*w+(px+i).coerceIn(0,w-1)]*k;weight+=k}
          reduced[y*nw+x]=sum/weight}
        image=reduced;w=nw;h=nh
      }
    };return result
  }
  private fun pixel(level: Level,x: Double,y: Double): Double {
    val ix=x.toInt();val iy=y.toInt();val fx=x-ix;val fy=y-iy;val p=iy*level.width+ix
    return (level.pixels[p]*(1-fx)+level.pixels[p+1]*fx)*(1-fy)+(level.pixels[p+level.width]*(1-fx)+level.pixels[p+level.width+1]*fx)*fy
  }
  /** Pyramidal Lucas-Kanade with a per-patch exposure offset, then backward verification. */
  private fun track(previous: List<Level>,current: List<Level>,x: Double,y: Double): DoubleArray? {
    var dx=0.0;var dy=0.0
    for(level in 2 downTo 0){
      if(level<2){dx*=2;dy*=2}
      val a=previous[level];val b=current[level];val scale=(1 shl level).toDouble();val px=x/scale;val py=y/scale
      if(px<6||py<6||px>=a.width-6||py>=a.height-6)return null
      val values=DoubleArray(81);val gx=DoubleArray(81);val gy=DoubleArray(81)
      var xx=0.0;var xy=0.0;var yy=0.0;var n=0
      for(j in -4..4)for(i in -4..4){val sx=px+i;val sy=py+j
        values[n]=pixel(a,sx,sy);gx[n]=(pixel(a,sx+1,sy)-pixel(a,sx-1,sy))*.5;gy[n]=(pixel(a,sx,sy+1)-pixel(a,sx,sy-1))*.5
        xx+=gx[n]*gx[n];xy+=gx[n]*gy[n];yy+=gy[n]*gy[n];n++}
      val det=xx*yy-xy*xy
      if(det<1e-5)return null
      var error=0.0
      for(iteration in 0..11){
        if(px+dx<5||py+dy<5||px+dx>=b.width-5||py+dy>=b.height-5)return null
        val residual=DoubleArray(81);var bias=0.0;n=0
        for(j in -4..4)for(i in -4..4){residual[n]=pixel(b,px+i+dx,py+j+dy)-values[n];bias+=residual[n];n++}
        bias/=81;var bx=0.0;var by=0.0;error=0.0
        for(k in 0..80){val r=residual[k]-bias;bx+=gx[k]*r;by+=gy[k]*r;error+=abs(r)}
        val ux=((-yy*bx+xy*by)/det).coerceIn(-3.0,3.0);val uy=((xy*bx-xx*by)/det).coerceIn(-3.0,3.0)
        dx+=ux;dy+=uy
        if(ux*ux+uy*uy<.0004)break
      }
      if(level==0 && error/81>20)return null
    }
    return doubleArrayOf(dx,dy)
  }

}

/** Symmetric smoothing uses future frames; the framing stays constant through a shot. */
internal object OfflineVideoPath {
  fun integrate(times: List<Long>, motions: List<FrameMotion>, cuts: Set<Int> = emptySet()): List<CameraPose> {
    require(times.size==motions.size)
    val result=ArrayList<CameraPose>();var x=0.0;var y=0.0;var angle=0.0
    val next=IntArray(times.size){-1};var nearest=-1
    for(i in times.indices.reversed()){if(i+1 in cuts)nearest=-1;if(motions[i].reliable)nearest=i;next[i]=nearest}
    var previous=-1
    for(i in times.indices){
      if(i in cuts){x=0.0;y=0.0;angle=0.0;previous=-1}
      var m=motions[i]
      if(m.reliable)previous=i
      else if(previous>=0){
        val a=motions[previous];val j=next[i];val gap=(times[i]-times[previous])/1e6
        if(j>=0 && (times[j]-times[previous])<300_000L){
          val f=(times[i]-times[previous]).toDouble()/(times[j]-times[previous]).coerceAtLeast(1)
          val b=motions[j];m=FrameMotion(a.x+(b.x-a.x)*f,a.y+(b.y-a.y)*f,a.angle+(b.angle-a.angle)*f,true)
        }else{val decay=exp(-gap/.12);m=FrameMotion(a.x*decay,a.y*decay,a.angle*decay,true)}
      }
      if(m.reliable){x+=m.x;y+=m.y;angle+=m.angle}
      result.add(CameraPose(times[i],x,y,angle,i in cuts))
    }
    return result
  }
  fun build(poses: List<CameraPose>, width: Int, height: Int, crop: Float, strength: String, rolls: List<RollSample>): VideoProcessingTimeline {
    require(poses.isNotEmpty())
    val sigma=when(strength){"action"->.32;"standard"->.16;else->.25}
    val result=ArrayList<VideoProcessingSample>()
    var start=0;var end=0
    for(i in poses.indices){
      val p=poses[i]
      if(p.cut) start=i
      while(start<i && p.timeUs-poses[start].timeUs>sigma*3e6)start++
      if(end<i)end=i
      while(end<poses.lastIndex && !poses[end+1].cut && poses[end+1].timeUs-p.timeUs<sigma*3e6)end++
      if(end<i)end=i
      var total=0.0;var sx=0.0;var sy=0.0;var sa=0.0
      for(j in start..end){val q=poses[j];val t=(q.timeUs-p.timeUs)/1e6;if(abs(t)>sigma*3)continue;val w=exp(-.5*(t/sigma).pow(2))
        total+=w;sx+=q.x*w;sy+=q.y*w;sa+=q.angle*w}

      sx/=total;sy/=total;sa/=total
      var angle=0.0
      if(rolls.isNotEmpty()){
        fun rollAt(timeUs: Long): Double {
          var lo=0;var hi=rolls.lastIndex
          while(hi-lo>1){val m=(lo+hi)/2;if(rolls[m].timeUs<=timeUs)lo=m else hi=m}
          val a=rolls[lo];val b=rolls[hi];val f=((timeUs-a.timeUs).toDouble()/(b.timeUs-a.timeUs).coerceAtLeast(1)).coerceIn(0.0,1.0)
          return a.radians+(b.radians-a.radians)*f
        }
        angle=rollAt(p.timeUs)
        if(strength!="action" && strength!="horizon"){
          var smooth=0.0;var weight=0.0
          for(j in start..end){val dt=(poses[j].timeUs-p.timeUs)/1e6;if(abs(dt)>sigma*3)continue;val w=exp(-.5*(dt/sigma).pow(2));smooth+=rollAt(poses[j].timeUs)*w;weight+=w}
          angle-=smooth/weight
        }
      }
      // Visual rotation is confounded by perspective when panning past nearby walls.
      // Without a gravity trace, retain the original roll and correct translation only.
      var x=(p.x-sx)/width;var y=(p.y-sy)/height
      // Fit correction to the requested budget, instead of zooming in/out frame by frame.
      // Absolute Horizon leveling may need extra crop; its scale is calculated once per shot below.
      if(strength!="action" && strength!="horizon" || rolls.isEmpty()){
        // Keep roll correction independent from pan pressure; coupling them makes the
        // horizon wobble whenever a pan reaches the translation margin.
        var lo=0.0;var hi=.25
        val rollBudget=1f+(crop-1f)*.65f
        repeat(18){val r=(lo+hi)/2;if(VideoProcessingGeometry.requiredCrop(VideoProcessingSample(0,0f,0f,r.toFloat()),width,height)<=rollBudget)lo=r else hi=r}
        angle=angle.coerceIn(-lo,lo)
        val rc=cos(angle);val rs=sin(angle)
        x=(p.x-sx)/width;y=(p.y-sy)/height
        val aspect=width.toDouble()/height;val safeCrop=crop/1.002
        val limitX=max(0.0,(1-(abs(rc)+abs(rs)/aspect)/safeCrop)*.5)
        val limitY=max(0.0,(1-(abs(rc)+abs(rs)*aspect)/safeCrop)*.5)
        x=x.coerceIn(-limitX,limitX);y=y.coerceIn(-limitY,limitY)
      }
      result.add(VideoProcessingSample(p.timeUs,x.toFloat(),y.toFloat(),angle.toFloat()))
    }
    val fixedCrop=max(crop,result.maxOf{VideoProcessingGeometry.requiredCrop(it,width,height)}*1.002f)
    return VideoProcessingTimeline(result,fixedCrop)
  }
}
