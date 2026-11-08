package expo.modules.icamera

import org.junit.Assert.*
import org.junit.Test

class PhoneCameraPolicyTest {
  @Test fun frontOneXUsesTheWidestHardwareZoomInsteadOfForcingNativeOneX() {
    assertEquals(.6f,PhoneCameraPolicy.hardwareZoom(true,1f,.6f,4f),0f)
    assertEquals(1.2f,PhoneCameraPolicy.hardwareZoom(true,2f,.6f,4f),.00001f)
    assertEquals(1f,PhoneCameraPolicy.hardwareZoom(false,1f,.6f,4f),0f)
    assertEquals(1.25f,PhoneCameraPolicy.hardwareZoom(true,1f,1.25f,4f),0f)
  }
  @Test fun zoomClampsToHardwareAndDigitalZoomStartsOnlyAfterActualLensLimit() {
    assertEquals(.6f,PhoneCameraPolicy.hardwareZoom(true,.2f,.6f,2f),0f)
    assertEquals(2f,PhoneCameraPolicy.hardwareZoom(true,10f,.6f,2f),0f)
    assertEquals(1f,PhoneCameraPolicy.digitalZoom(true,3f,.6f,2f),0f)
    assertEquals(1.2f,PhoneCameraPolicy.digitalZoom(true,4f,.6f,2f),.00001f)
    assertEquals(2f,PhoneCameraPolicy.digitalZoom(false,4f,.6f,2f),0f)
  }
  @Test fun hardwareFieldOfViewPrefersWiderRecordableLens() {
    val main=PhoneCameraPolicy.viewScore(5f,4f,4f,1f)
    val wide=PhoneCameraPolicy.viewScore(5f,4f,2f,1f)
    assertTrue(wide>main)
    assertTrue(PhoneCameraPolicy.viewScore(5f,4f,4f,.6f)>main)
    assertEquals(0.0,PhoneCameraPolicy.viewScore(0f,4f,4f,1f),0.0)
  }
}
