package expo.modules.icamera

import org.junit.Assert.*
import org.junit.Test
import kotlin.math.*

class VideoTuningTest {
  @Test fun rearActionAndHorizonCropPolicy() {
    assertEquals(1.28f, VideoStabilityPolicy.crop("action", "off"), .001f)
    assertEquals(1.24f, VideoStabilityPolicy.crop("video", "horizon"), .001f)
    assertTrue(VideoStabilityPolicy.horizon("video", "horizon"))
    assertFalse(VideoStabilityPolicy.horizon("video", "off"))
    assertEquals(1f, VideoStabilityPolicy.crop("video", "off"), 0f)
  }
  @Test fun supportedRearEisDoesNotReceiveAnotherProcessingCrop() {
    assertEquals(1f,VideoStabilityPolicy.crop("video","cinematic",false,true),0f)
    assertEquals(1.16f,VideoStabilityPolicy.crop("video","cinematic",false,false),.001f)
  }
  @Test fun selfieFramingDoesNotStackOrdinarySoftwareAndHardwareCrop() {
    for (style in listOf("standard", "cinematic")) {
      assertEquals(1f, VideoStabilityPolicy.crop("video", style, true, true), 0f)
      assertTrue(VideoStabilityPolicy.crop("video", style, true, false) <= 1.08f)
    }
    assertEquals(1f, VideoStabilityPolicy.crop("video", "off", true, false), 0f)
    assertEquals(1.04f, VideoStabilityPolicy.crop("action", "cinematic", true, true), .001f)
    assertEquals(1.12f, VideoStabilityPolicy.crop("action", "off", true, false), .001f)
    assertEquals(1f, VideoStabilityPolicy.crop("video", "horizon", true, true), .001f)
    assertEquals(1.08f, VideoStabilityPolicy.crop("video", "horizon", true, false), .001f)
  }
  @Test fun cropReservesEnoughRoomForSuddenRollInBothDirections() {
    for (degrees in listOf(-80, -45, -20, 0, 20, 45, 80)) {
      val a = Math.toRadians(degrees.toDouble()).toFloat()
      val need = abs(cos(a)) + (1920f / 1080f) * abs(sin(a))
      assertTrue(VideoStabilityPolicy.rotationCrop(1080f, 1920f, a, 1f) >= need)
    }
  }
  @Test fun levelHorizonAddsNoUnnecessaryRotationCrop() {
    assertEquals(1f, VideoStabilityPolicy.rotationCrop(1080f,1920f,0f,1f),0f)
  }
  @Test fun fixedFrameRateIsPreferredOverExposurePumping() {
    assertEquals(30 to 30, VideoStabilityPolicy.frameRate(listOf(15 to 30, 30 to 30), 30))
    assertEquals(60 to 60, VideoStabilityPolicy.frameRate(listOf(30 to 60, 60 to 60), 60))
    assertEquals(24 to 30, VideoStabilityPolicy.frameRate(listOf(15 to 30, 24 to 30), 30))
  }
  @Test fun jitterIsSuppressedAndLongPansStayInsideCropReserve() {
    val path = VideoCameraPath()
    var previous = 0f
    var outputEnergy = 0.0
    repeat(600) { i ->
      val step = if (i % 2 == 0) .004 else -.004
      val out = path.update(step, .001, 1.0 / 60, 1.28f, true)
      assertTrue(out.all { it.isFinite() && abs(it) < .11f })
      outputEnergy += abs(step - (out[0] - previous)); previous = out[0]
    }
    assertTrue(outputEnergy < 600 * .004 * .55)
  }
  @Test fun pathDecayMatchesAtThirtyAndSixtyFpsAndResetsOnGap() {
    fun result(rate: Int): Float { val p = VideoCameraPath();p.update(.02, 0.0, 1.0 / rate, 1.28f, true); repeat(rate) { p.update(0.0,0.0,1.0/rate,1.28f,true) }; return p.update(0.0,0.0,1.0/rate,1.28f,true)[0] }
    assertEquals(result(30), result(60), .001f)
    val path = VideoCameraPath();path.update(.05, .01, .03, 1.28f, true)
    assertEquals(0f, path.update(.1,.1,.5,1.28f,true)[0],0f)
  }
  @Test fun exposureChangesDoNotMasqueradeAsMotion() {
    val w=160;val h=90
    val prev=IntArray(w*h) { i -> 60 + (((i%w)*73 + (i/w)*127 + (i%w)*(i/w)*7) % 110) }
    val cur=IntArray(w*h) { i -> val x=(i%w-2).coerceIn(0,w-1);val y=(i/w+1).coerceIn(0,h-1);prev[y*w+x]+20 }
    val shift=VideoMotionEstimator.estimate(prev,cur,w,h)
    assertNotNull(shift);assertEquals(2.0,shift!![0],.3);assertEquals(-1.0,shift[1],.3)
    assertNull(VideoMotionEstimator.estimate(IntArray(w*h){100},IntArray(w*h){110},w,h))
  }
  @Test fun toneProtectsHighlightsAndNeutralBalanceIsBounded() {
    assertTrue(VideoTonePolicy.gain(.10f,.9f,.99f) <= 1.1f)
    assertTrue(VideoTonePolicy.gain(.04f,.3f,.4f) <= 1.65f)
    assertEquals(1f,VideoTonePolicy.gain(.7f,.9f,1f),0f)
    assertArrayEquals(floatArrayOf(1f,1f,1f),VideoTonePolicy.neutralGains(100.0,60.0,30.0,2,200),0f)
    assertTrue(VideoTonePolicy.neutralGains(100.0,90.0,80.0,200,200).all { it in .96f..1.04f })
  }
}
