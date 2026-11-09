package expo.modules.icamera

/** GL-thread lease accounting: CameraX must return inputs before their context is destroyed. */
internal class SurfaceRetirement {
  private var inputs=0
  private var outputsClosed=false
  private var destroyed=false
  fun acquireInput() { check(!outputsClosed);inputs++ }
  fun returnInput() { check(inputs>0);inputs-- }
  fun closeOutputs() { outputsClosed=true }
  fun beginDestroy(): Boolean {
    if(!outputsClosed || inputs!=0 || destroyed)return false
    destroyed=true
    return true
  }
}
