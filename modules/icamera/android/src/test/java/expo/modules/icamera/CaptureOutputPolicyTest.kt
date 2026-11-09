package expo.modules.icamera

import org.junit.Assert.*
import org.junit.Test

class CaptureOutputPolicyTest {
  @Test fun highResolutionCameraIntentPreviewsStayWithinBinderBudget() {
    for((w,h) in listOf(4000 to 3000,16320 to 12240,12000 to 16000,320 to 240)) {
      val sample=CaptureOutputPolicy.thumbnailSample(w,h)
      assertTrue(maxOf(w,h)/sample<=320);assertEquals(0,sample and (sample-1))
    }
  }
  @Test fun invalidOrHugeMetadataDoesNotOverflowTheSamplingLoop() {
    assertEquals(1,CaptureOutputPolicy.thumbnailSample(0,0))
    assertTrue(CaptureOutputPolicy.thumbnailSample(Int.MAX_VALUE,Int.MAX_VALUE)>0)
  }
}
