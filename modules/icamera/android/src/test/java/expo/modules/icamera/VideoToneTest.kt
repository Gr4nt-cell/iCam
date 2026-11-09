package expo.modules.icamera
import org.junit.Assert.*
import org.junit.Test
class VideoToneTest {
  @Test fun toneProtectsHighlightsAndNeutralBalanceIsBounded() {
    assertTrue(VideoTonePolicy.gain(.10f,.9f,.99f)<=1.1f)
    assertTrue(VideoTonePolicy.gain(.04f,.3f,.4f)<=1.65f)
    assertEquals(1f,VideoTonePolicy.gain(.7f,.9f,1f),0f)
    assertArrayEquals(floatArrayOf(1f,1f,1f),VideoTonePolicy.neutralGains(100.0,60.0,30.0,2,200),0f)
    assertTrue(VideoTonePolicy.neutralGains(100.0,90.0,80.0,200,200).all { it in .96f..1.04f })
  }
}
