package expo.modules.icamera

import org.junit.Assert.*
import org.junit.Test

class SurfaceRetirementTest {
  @Test fun movingDisplaysWaitsForEveryCameraInput() {
    val leases=SurfaceRetirement();leases.acquireInput();leases.acquireInput()
    leases.closeOutputs();assertFalse(leases.beginDestroy())
    leases.returnInput();assertFalse(leases.beginDestroy())
    leases.returnInput();assertTrue(leases.beginDestroy());assertFalse(leases.beginDestroy())
  }
  @Test fun inputReturningBeforeTheReleaseTaskDoesNotDestroyOutputsEarly() {
    val leases=SurfaceRetirement();leases.acquireInput();leases.returnInput()
    assertFalse(leases.beginDestroy());leases.closeOutputs();assertTrue(leases.beginDestroy())
  }
  @Test fun repeatedDetachClosesOnlyOnceEvenWithoutAnInput() {
    val leases=SurfaceRetirement();leases.closeOutputs();leases.closeOutputs()
    assertTrue(leases.beginDestroy());assertFalse(leases.beginDestroy())
  }
}
