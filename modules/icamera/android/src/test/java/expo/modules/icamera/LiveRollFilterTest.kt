package expo.modules.icamera
import org.junit.Assert.*
import org.junit.Test
import kotlin.math.*
class LiveRollFilterTest {
  @Test fun landscapeDoesNotGetAnUnnecessaryNinetyDegreeCrop(){
    val f=LiveRollFilter();assertEquals(.02f,f.update((PI/2+.02).toFloat(),1.0/30,true,.02f),.0001f)
  }
  @Test fun lateFirstSensorSampleDoesNotRotateLandscapeNinetyDegrees(){
    val f=LiveRollFilter();f.update(0f,1.0/30,true,.02f)
    assertEquals(0f,f.update((PI/2).toFloat(),1.0/30,true,.02f),.0001f)
  }
  @Test fun wrapDoesNotJumpAndTremorIsBounded(){
    val f=LiveRollFilter();f.update(3.13f,1.0/60,false,.012f)
    assertTrue(abs(f.update(-3.13f,1.0/60,false,.012f))<=.012f)
    f.reset();f.update(0f,1.0/30,false,.012f)
    repeat(90){assertTrue(abs(f.update(if(it%2==0).1f else -.1f,1.0/30,false,.012f))<=.012f)}
  }
  @Test fun steadyTiltSettlesAndPauseReanchors(){
    val f=LiveRollFilter();f.update(0f,1.0/30,false,.025f)
    var last=0f;repeat(180){last=f.update(.12f,1.0/30,false,.025f)}
    assertTrue(abs(last)<.001f);assertEquals(0f,f.update(.5f,2.0,false,.025f),.00001f)
  }
  @Test fun normalRollSharesTheOriginalCropBudget(){
    for(base in listOf(1.06f,1.08f,1.16f))for(angle in listOf(-.012f,0f,.012f)){
      val rotation=VideoStabilityPolicy.rotationCrop(1080f,1920f,angle,1f)
      val translation=VideoStabilityPolicy.motionCrop(base,rotation,true)
      assertEquals(base,rotation*translation,.0001f)
    }
  }

}
