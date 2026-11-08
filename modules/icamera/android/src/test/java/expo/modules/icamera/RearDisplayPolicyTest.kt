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
  @Test fun rootShellParserRejectsForeignTasks() {
    val own="RootTask id=42 bounds=[0,0][900,600] displayId=0\n  taskId=42: com.gr4nt.icam/.MainActivity bounds=[0,0][900,600] userId=0 visible=true"
    assertEquals(42,RearDisplayPolicy.rootFromShell(own,42,"com.gr4nt.icam"))
    assertNull(RearDisplayPolicy.rootFromShell(own+"\n  taskId=90: other.app/.Activity",42,"com.gr4nt.icam"))
    assertNull(RearDisplayPolicy.rootFromShell(own,90,"com.gr4nt.icam"))
  }

  @Test fun onlyBuiltInRearSizedDisplaysExposeTheSwitch() {
    assertTrue(RearDisplayPolicy.isRearDisplay(7,1,"Built-in Screen",904,596,true))
    assertFalse(RearDisplayPolicy.isRearDisplay(0,1,"Built-in Screen",1220,2656,false))
    for(type in listOf(2,3,4,5))assertFalse(RearDisplayPolicy.isRearDisplay(7,type,"Rear display",904,596,true))
    assertFalse(RearDisplayPolicy.isRearDisplay(7,null,"Living room TV",1280,720,false))
    assertFalse(RearDisplayPolicy.isRearDisplay(7,1,"Inner fold",1840,2208,true))
    assertTrue(RearDisplayPolicy.isRearDisplay(7,null,"Built-in Screen",904,596,true))
  }

}
