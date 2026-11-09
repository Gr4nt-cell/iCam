package expo.modules.icamera

import org.junit.Assert.*
import org.junit.Test

class UiRefreshPolicyTest {
  @Test fun highRefreshDisplaysTarget120WithoutChangingTheCameraRate() {
    assertEquals(120f,UiRefreshPolicy.target(listOf(60f,90f,120f,144f)),0f)
  }
  @Test fun rearAndLowEndDisplaysUseTheirAvailableRefreshRate() {
    assertEquals(60f,UiRefreshPolicy.target(listOf(60f)),0f)
    assertEquals(90f,UiRefreshPolicy.target(listOf(60f,90f)),0f)
    assertEquals(120f,UiRefreshPolicy.target(listOf(144f)),0f)
  }
  @Test fun invalidDisplayReportsDoNotGenerateAnInvalidWindowRequest() {
    assertEquals(60f,UiRefreshPolicy.target(listOf(Float.NaN,0f,Float.POSITIVE_INFINITY)),0f)
    assertEquals(60f,UiRefreshPolicy.target(emptyList()),0f)
  }
}
