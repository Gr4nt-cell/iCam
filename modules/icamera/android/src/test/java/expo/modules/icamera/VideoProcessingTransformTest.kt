package expo.modules.icamera

import org.junit.Assert.*
import org.junit.Test
import kotlin.math.*

class VideoProcessingTransformTest {
  @Test fun transformedCornersAlwaysCoverFrameForPortraitLandscapeAndSelfies() {
    for ((w,h) in listOf(1080 to 1920,1920 to 1080,1080 to 1080)) {
      for (crop in listOf(1.06f,1.08f,1.10f,1.16f,1.28f)) {
        val limit = ((1f-1f/crop)/2f-.002f).coerceAtLeast(0f)
        for (degrees in listOf(-89,-45,-20,0,20,45,89)) for (sign in listOf(-1,1)) {
          val m=VideoProcessingGeometry.matrix(VideoProcessingSample(0,limit*sign,-limit*sign,Math.toRadians(degrees.toDouble()).toFloat()),w,h,crop)
          val det=m[0]*m[4]-m[1]*m[3]
          assertTrue(det>0)
          for (x in listOf(-1f,1f)) for (y in listOf(-1f,1f)) {
            val px=x-m[2]; val py=y-m[5]
            val sx=(m[4]*px-m[1]*py)/det
            val sy=(-m[3]*px+m[0]*py)/det
            assertTrue("Exposed x corner: $sx",abs(sx)<=1.00001f)
            assertTrue("Exposed y corner: $sy",abs(sy)<=1.00001f)
          }
        }
      }
    }
  }
  @Test fun translationCancelsImageMotionWithCorrectBitmapYDirection() {
    val m=VideoProcessingGeometry.matrix(VideoProcessingSample(0,.01f,.02f,0f),1080,1920,1.1f)
    val movingX=.02f; val movingY=-.04f
    assertEquals(0f,m[0]*movingX+m[1]*movingY+m[2],.00001f)
    assertEquals(0f,m[3]*movingX+m[4]*movingY+m[5],.00001f)
  }
  @Test fun normalSelfieHasOnlyTheRequestedProcessingMargin() {
    val m=VideoProcessingGeometry.matrix(VideoProcessingSample(0,0f,0f,0f),1080,1920,1.06f)
    assertEquals(1.06f,m[0],.00001f);assertEquals(1.06f,m[4],.00001f)
    assertEquals(0f,m[2],0f);assertEquals(0f,m[5],0f)
  }
  @Test fun timelineInterpolatesAtSixtyFpsAndIsSeekSafe() {
    val t=VideoProcessingTimeline(listOf(VideoProcessingSample(0,0f,0f,0f),VideoProcessingSample(33334,.02f,-.01f,.1f)))
    val mid=t.at(16667)
    assertEquals(.01f,mid.x,.00001f);assertEquals(-.005f,mid.y,.00001f)
    assertEquals(.05f,mid.roll,.00001f)
    t.at(90000);assertEquals(mid,t.at(16667))
    assertEquals(0f,t.at(-20).x,0f)
  }
  @Test fun gravityTimelineExcludesPausedWallTimeAndHandlesLandscape() {
    val t=RecordingRollTrace(false)
    t.resume(0,1_000_000_000,PI.toFloat()/2+.1f)
    t.add(1_100_000_000,PI.toFloat()/2+.2f)
    t.pause();t.add(3_000_000_000,1f)
    t.resume(100_000,8_000_000_000,PI.toFloat()/2+.25f)
    t.add(8_050_000_000,PI.toFloat()/2+.3f)
    val s=t.snapshot()
    assertEquals(listOf(0L,100_000L,100_000L,150_000L),s.map { it.timeUs })
    assertEquals(.1f,s.first().radians,.0001f);assertEquals(.3f,s.last().radians,.0001f)
  }
  @Test fun rollUnwrapAndUnmirroredFrontSignDoNotJump() {
    val t=RecordingRollTrace(true)
    t.resume(0,0,3.13f);t.add(10_000_000,-3.13f)
    val s=t.snapshot()
    assertTrue(abs(s[1].radians-s[0].radians)<.03f)
    assertTrue(s[0].radians>0f);assertTrue(s[1].radians<0f)
  }
}
