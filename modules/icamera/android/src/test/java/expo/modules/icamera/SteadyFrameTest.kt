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
    repeat(80){t=e.update(source,w,h,1_000_000_000L+it*33_333_333L,1.04f,0f,false)}
    assertEquals(0f,t.x,.00001f);assertEquals(0f,t.y,.00001f)
  }
  @Test fun currentFrameCorrectionReducesKnownWalkingFrequencyJitter() {
    val e=SteadyFrame();var before=0.0;var after=0.0
    repeat(120){i ->
      val x=1.6*sin(i*2*PI*2.4/30)
      val t=e.update(frame(x),w,h,1_000_000_000L+i*33_333_333L,1.04f,0f,false)
      if(i>15){before+=x*x;after+=(x-t.x*w).pow(2)}
      assertEquals(1.04f,t.crop,0f)
    }
    assertTrue("jitter RMS ratio=${sqrt(after/before)}",sqrt(after/before)<.6)
  }
  @Test fun timestampDiscontinuityAndLensChangeResetThePath() {
    val e=SteadyFrame();e.update(source,w,h,1_000_000_000L,1.08f,0f,false)
    e.update(frame(2.0),w,h,1_033_333_333L,1.08f,0f,false)
    val reset=e.update(source,w,h,2_000_000_000L,1.08f,0f,false)
    assertEquals(0f,reset.x,0f);e.reset()
    assertEquals(0f,e.update(source,w,h,3_000_000_000L,1.08f,0f,false).x,0f)
  }
  @Test fun correctionAlwaysFitsTheReservedMarginInNormalModes() {
    val e=SteadyFrame()
    repeat(60){i ->
      val t=e.update(frame(min(i*.6,9.0)),w,h,1_000_000_000L+i*33_333_333L,1.04f,(.03*sin(i*.4)).toFloat(),false,16f/9)
      val c=abs(cos(t.angle.toDouble()));val s=abs(sin(t.angle.toDouble()))
      assertTrue(abs(t.x)+(c+s/(16.0/9))/(2*t.crop)<=.5+.00001)
      assertTrue(abs(t.y)+(c+s*(16.0/9))/(2*t.crop)<=.5+.00001)
    }
  }
  @Test fun hardwareStabilizationNeverGetsACumulativeCrop() {
    for(mode in listOf("video","action","pvideo")) for(setting in listOf("standard","cinematic","horizon"))
      assertEquals(1f,CaptureStability.crop(mode,setting,false,true),0f)
    assertEquals(1f,CaptureStability.crop("video","off"),0f)
    assertTrue(CaptureStability.crop("action","standard")<=1.12f)
  }
  @Test fun horizonDoesNotZoomInFurtherAtLargeTilts() {
    val e=SteadyFrame()
    val t=e.update(source,w,h,1_000_000_000L,1.10f,.7f,true)
    assertEquals(1.10f,t.crop,0f);assertEquals(.7f,t.angle,.001f)
  }
  @Test fun sharedSessionModeIsSelectedBeforeVideoOnlyMode() {
    assertEquals(CaptureStabilityPlan(true,false),CaptureStability.plan(true,false,true,true,false))
    assertFalse(CaptureStability.plan(true,false,false,true,false).hardware)
    assertTrue(CaptureStability.plan(true,false,false,true,true).video)
    assertFalse(CaptureStability.plan(false,false,true,true,false).hardware)
    assertFalse(CaptureStability.plan(true,true,true,true,false).hardware)
  }
  @Test fun encoderAuditRespectsTheActiveIntervalAfterResume() {
    assertFalse(CaptureStability.deliveryStalled(50_000_000,0));assertTrue(CaptureStability.deliveryStalled(2_100_000_000,0))
    assertFalse(CaptureStability.deliveryStalled(2_100_000_000,1))
  }
}
