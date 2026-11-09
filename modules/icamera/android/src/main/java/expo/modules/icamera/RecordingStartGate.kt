package expo.modules.icamera

/** A cancelled sound-delay callback cannot start a recorder or cancel a newer start. */
internal class RecordingStartGate {
  private var generation=0L
  var pending=false
    private set
  fun begin(): Long { check(!pending);pending=true;return ++generation }
  fun consume(token: Long): Boolean {
    if(!pending || generation!=token)return false
    pending=false;return true
  }
  fun cancel(): Boolean { val had=pending;pending=false;generation++;return had }
}
