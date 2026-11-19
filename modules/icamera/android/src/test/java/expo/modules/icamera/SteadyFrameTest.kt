package expo.modules.icamera

import org.junit.Assert.*
import org.junit.Test
import kotlin.math.*

class SteadyFrameTest {
  private val w=160;private val h=90
  private val source=IntArray(w*h) { i -> val x=i%w;val y=i/w
    (120+32*sin(x*.37)+28*cos(y*.51)+24*sin(x*.23+y*.31)+15*cos(x*.81-y*.63)).roundToInt().coerceIn(0,255) }
  private fun frame(dx:Double,dy:Double=0.0,bias:Int=0):IntArray = IntArray(w*h){i->
    val x=(i%w-dx).coerceIn(0.0,w-1.001);val y=(i/w-dy).coerceIn(0.0,h-1.001)
    val ix=x.toInt();val iy=y.toInt();val a=x-ix;val b=y-iy
    ((source[iy*w+ix]*(1-a)+source[iy*w+ix+1]*a)*(1-b)+(source[(iy+1)*w+ix]*(1-a)+source[(iy+1)*w+ix+1]*a)*b+bias).roundToInt().coerceIn(0,255)
  }
  @Test fun tracksTranslationWithAnExposureChange() {
    val t=PyramidTranslation.measure(source,frame(3.0,-2.0,18),w,h)
    assertNotNull(t);assertEquals(3.0,t!!.x*w,.35);assertEquals(-2.0,t.y*h,.35)
  }
  @Test fun pyramidRecoversMotionOutsideOldSixPixelSearch() {
    val t=PyramidTranslation.measure(source,frame(7.0,4.0),w,h)
    assertNotNull(t);assertEquals(7.0,t!!.x*w,.4);assertEquals(4.0,t.y*h,.4)
  }
  @Test fun blankFramesHaveNoInventedMotion() {
    assertNull(PyramidTranslation.measure(IntArray(w*h){42},IntArray(w*h){64},w,h))
  }
  @Test fun stationaryFramesDoNotDrift() {
    val e=SteadyFrame();var t=SteadyTransform()
    repeat(80){t=e.update(source,w,h,1_000_000_000L+it*33_333_333L,1.04f)}
    assertEquals(0f,t.x,.00001f);assertEquals(0f,t.y,.00001f)
  }
  @Test fun currentFrameCorrectionReducesKnownWalkingFrequencyJitter() {
    val e=SteadyFrame();var before=0.0;var after=0.0
    repeat(120){i ->
      val x=1.6*sin(i*2*PI*2.4/30)
      val t=e.update(frame(x),w,h,1_000_000_000L+i*33_333_333L,1.04f)
      if(i>15){before+=x*x;after+=(x-t.x*w).pow(2)}
      assertEquals(1.04f,t.crop,0f)
    }
    assertTrue("jitter RMS ratio=${sqrt(after/before)}",sqrt(after/before)<.6)
  }
  @Test fun timestampDiscontinuityAndLensChangeResetThePath() {
    val e=SteadyFrame();e.update(source,w,h,1_000_000_000L,1.08f)
    e.update(frame(2.0),w,h,1_033_333_333L,1.08f)
    val reset=e.update(source,w,h,2_000_000_000L,1.08f)
    assertEquals(0f,reset.x,0f);e.reset()
    assertEquals(0f,e.update(source,w,h,3_000_000_000L,1.08f).x,0f)
  }
  @Test fun correctionAlwaysFitsTheReservedMarginInNormalModes() {
    val e=SteadyFrame()
    repeat(60){i ->
      val t=e.update(frame(min(i*.6,9.0)),w,h,1_000_000_000L+i*33_333_333L,1.04f,16f/9)
      val c=abs(cos(t.angle.toDouble()));val s=abs(sin(t.angle.toDouble()))
      assertTrue(abs(t.x)+(c+s/(16.0/9))/(2*t.crop)<=.5+.00001)
      assertTrue(abs(t.y)+(c+s*(16.0/9))/(2*t.crop)<=.5+.00001)
    }
  }
  @Test fun hardwareStabilizationNeverGetsACumulativeCrop() {
    for(mode in listOf("video","action","pvideo")) for(setting in listOf("standard","cinematic"))
      assertEquals(1f,CaptureStability.crop(mode,setting,false,true),0f)
    assertEquals(1f,CaptureStability.crop("video","off"),0f)
    assertTrue(CaptureStability.crop("action","standard")<=1.15f)
  }
  @Test fun sharedSessionModeIsSelectedBeforeVideoOnlyMode() {
    assertEquals(CaptureStabilityPlan(true,null),CaptureStability.plan(true,true,true,false))
    // Video-stream EIS is used in SDR too when preview stabilization isn't offered.
    assertEquals(CaptureStabilityPlan(null,true),CaptureStability.plan(true,false,true,false))
    assertEquals(true,CaptureStability.plan(true,false,true,true).video)
    assertFalse(CaptureStability.plan(true,false,false,false).hardware)
    assertFalse(CaptureStability.plan(false,true,true,false).hardware)
  }
  @Test fun previewOnlyAndVideoOnlyPlansNeverSetTheOpposingOffFlag() {
    val shared=CaptureStability.plan(true,true,true,false)
    val previewWrites=mutableListOf<Boolean>();val videoWrites=mutableListOf<Boolean>()
    shared.configurePreview { previewWrites.add(it) };shared.configureVideo { videoWrites.add(it) }
    assertEquals(listOf(true),previewWrites);assertTrue(videoWrites.isEmpty())
    val native=CaptureStability.plan(true,false,true,true)
    previewWrites.clear();videoWrites.clear()
    native.configurePreview { previewWrites.add(it) };native.configureVideo { videoWrites.add(it) }
    assertTrue(previewWrites.isEmpty());assertEquals(listOf(true),videoWrites)
    // Documented CameraX table: an explicit OFF on either stream defeats the other ON.
    for(plan in listOf(shared,native)) assertFalse(plan.hardware && (plan.preview==false || plan.video==false))
  }
  @Test fun encoderAuditRespectsTheActiveIntervalAfterResume() {
    assertFalse(CaptureStability.deliveryStalled(50_000_000,0));assertTrue(CaptureStability.deliveryStalled(2_100_000_000,0))
    assertFalse(CaptureStability.deliveryStalled(2_100_000_000,1))
  }

  private fun rotatedFrame(angle: Double, dx: Double=0.0, dy: Double=0.0): IntArray = IntArray(w*h){i ->
    val px=i%w-w/2.0-dx;val py=i/w-h/2.0-dy
    val x=(cos(angle)*px+sin(angle)*py+w/2.0).coerceIn(0.0,w-1.001)
    val y=(-sin(angle)*px+cos(angle)*py+h/2.0).coerceIn(0.0,h-1.001)
    val ix=x.toInt();val iy=y.toInt();val a=x-ix;val b=y-iy
    ((source[iy*w+ix]*(1-a)+source[iy*w+ix+1]*a)*(1-b)+(source[(iy+1)*w+ix]*(1-a)+source[(iy+1)*w+ix+1]*a)*b).roundToInt().coerceIn(0,255)
  }
  @Test fun tracksRotationAndTranslationTogether() {
    val t=PyramidTranslation.measure(source,rotatedFrame(.025,2.0,-1.0),w,h)
    assertNotNull(t);assertEquals(.025,t!!.angle,.007)
    assertEquals(2.0,t.x*w,.4);assertEquals(-1.0,t.y*h,.4)
  }
  @Test fun movingForegroundDoesNotSteerTheCameraPath() {
    val current=frame(2.0,-1.0)
    for(y in 25..58)for(x in 50..96)current[y*w+x]=(x*71+y*37)%256
    val t=PyramidTranslation.measure(source,current,w,h)
    assertNotNull(t);assertEquals(2.0,t!!.x*w,.5);assertEquals(-1.0,t.y*h,.5)
    assertEquals(0.0,t.angle,.009)
  }
  @Test fun savedFrameRotationCorrectionReducesRollShakeAtThirtyAndSixtyFps() {
    for(fps in listOf(30,60)){
      val e=SteadyFrame();var before=0.0;var after=0.0
      repeat(fps*3){i ->
        val angle=.008*sin(i*2*PI*2.4/fps)
        val t=e.update(rotatedFrame(angle),w,h,1_000_000_000L+i*(1_000_000_000L/fps),1.08f)
        if(i>fps/2){before+=angle*angle;after+=(angle+t.angle).pow(2)}
        assertEquals(1.08f,t.crop,0f)
        val c=abs(cos(t.angle.toDouble()));val sn=abs(sin(t.angle.toDouble()))
        assertTrue(abs(t.x)+(c+sn/(16.0/9))/(2*t.crop)<=.5+.00001)
        assertTrue(abs(t.y)+(c+sn*(16.0/9))/(2*t.crop)<=.5+.00001)
      }
      assertTrue("roll RMS ratio at $fps fps=${sqrt(after/before)}",sqrt(after/before)<.72)
    }
  }
  @Test fun constantPanSettlesWithoutFightingTheOperator() {
    val e=SteadyFrame();var t=SteadyTransform()
    repeat(120){i -> t=e.update(rotatedFrame(0.0,i*.12),w,h,1_000_000_000L+i*33_333_333L,1.08f) }
    assertTrue(abs(t.x*w)<.8)
  }
}
