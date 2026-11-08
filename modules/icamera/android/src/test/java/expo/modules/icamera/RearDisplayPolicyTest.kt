package expo.modules.icamera
import org.junit.Assert.*
import org.junit.Test

class RearDisplayPolicyTest {
  @Test fun targetsMustBeAttachedAndNeverAssumeDisplayOne() {
    assertTrue(RearDisplayPolicy.validTarget(0,listOf(0,7)))
    assertTrue(RearDisplayPolicy.validTarget(7,listOf(0,7)))
    assertFalse(RearDisplayPolicy.validTarget(1,listOf(0,7)))
    assertFalse(RearDisplayPolicy.validTarget(-1,listOf(0,7)))
  }
  @Test fun ownFullscreenTaskCanMove() {
    assertTrue(RearDisplayPolicy.ownRootTask(42,42,intArrayOf(),"com.gr4nt.icam","com.gr4nt.icam"))
    assertTrue(RearDisplayPolicy.ownRootTask(1,42,intArrayOf(42),"com.gr4nt.icam","com.gr4nt.icam"))
  }
  @Test fun anotherAppOrSharedMultiwindowRootCannotMove() {
    assertFalse(RearDisplayPolicy.ownRootTask(1,42,intArrayOf(42),"other.app","com.gr4nt.icam"))
    assertFalse(RearDisplayPolicy.ownRootTask(1,42,intArrayOf(42,43),"com.gr4nt.icam","com.gr4nt.icam"))
    assertFalse(RearDisplayPolicy.ownRootTask(1,42,intArrayOf(43),"com.gr4nt.icam","com.gr4nt.icam"))
  }
}
