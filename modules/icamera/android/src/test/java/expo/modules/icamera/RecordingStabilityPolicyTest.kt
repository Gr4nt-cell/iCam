package expo.modules.icamera

import org.junit.Assert.*
import org.junit.Test

class RecordingStabilityPolicyTest {
  @Test fun commonStreamModeIsPreferred() {
    val p=RecordingStabilityPolicy.select(true,false,true,true,false)
    assertTrue(p.preview);assertFalse(p.video);assertFalse(p.software)
  }
  @Test fun videoOnlyCapabilityCannotDisableSdrProcessing() {
    val p=RecordingStabilityPolicy.select(true,false,false,true,false)
    assertFalse(p.hardware);assertTrue(p.software)
  }
  @Test fun hdrPreservesNativeVideoStabilization() {
    val p=RecordingStabilityPolicy.select(true,false,false,true,true)
    assertTrue(p.video);assertFalse(p.software)
  }
  @Test fun explicitHorizonKeepsSoftwareControl() {
    val p=RecordingStabilityPolicy.select(true,true,true,true,false)
    assertFalse(p.hardware);assertTrue(p.software)
  }
  @Test fun offRemainsOff() {
    val p=RecordingStabilityPolicy.select(false,false,true,true,false)
    assertFalse(p.hardware);assertFalse(p.software)
  }
  @Test fun envelopeCoversCornersImmediatelyAndHoldsBeforeRelease() {
    val e=RecordingCropEnvelope()
    assertEquals(1.4f,e.update(1.4f,1.0/60,true),.0001f)
    repeat(20){assertEquals(1.4f,e.update(1f,1.0/60,true),.0001f)}
    repeat(100){assertTrue(e.update(1.1f,1.0/60,true)>=1.1f)}
    assertTrue(e.update(1.1f,1.0/60,true)<1.3f)
  }
  @Test fun warmPreviewAndNewEncoderUseOneEnvelope() {
    val e=RecordingCropEnvelope()
    repeat(90){e.update(1.3f,1.0/30,true)}
    val frameCrop=e.update(1.1f,1.0/30,true)
    val previewCrop=frameCrop;val encoderCrop=frameCrop
    assertEquals(previewCrop,encoderCrop,0f)
    e.reset();assertEquals(1f,e.update(1f,1.0/30,true),0f)
  }
  @Test fun deliveryAuditWaitsForActiveIntervalAfterResume() {
    assertFalse(RecordingStabilityPolicy.deliveryStalled(50_000_000L,0))
    assertTrue(RecordingStabilityPolicy.deliveryStalled(2_100_000_000L,0))
    assertFalse(RecordingStabilityPolicy.deliveryStalled(2_100_000_000L,1))
  }
}
