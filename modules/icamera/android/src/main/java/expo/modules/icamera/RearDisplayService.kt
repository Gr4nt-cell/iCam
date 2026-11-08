package expo.modules.icamera

import android.content.ComponentName
import android.content.Context
import android.os.Binder
import android.os.IBinder
import android.os.Parcel
import androidx.annotation.Keep
import java.util.concurrent.TimeUnit

/** Optional Shizuku user service. It can move only iCam's own foreground task. */
@Keep
class RearDisplayService(private val context: Context) : Binder() {
  companion object {
    const val DESCRIPTOR = "expo.modules.icamera.RearDisplayService"
    const val MOVE = IBinder.FIRST_CALL_TRANSACTION
  }

  override fun onTransact(code: Int, data: Parcel, reply: Parcel?, flags: Int): Boolean {
    if(code == IBinder.INTERFACE_TRANSACTION){reply?.writeString(DESCRIPTOR);return true}
    if(code == 16777115){android.os.Process.killProcess(android.os.Process.myPid());return true}
    if(code != MOVE)return super.onTransact(code,data,reply,flags)
    data.enforceInterface(DESCRIPTOR)
    try {
      val ownPackage=context.packageName
      val uid=context.packageManager.getApplicationInfo(ownPackage,0).uid
      check(Binder.getCallingUid()==uid) { "Only iCam may use its screen service" }
      val task=data.readInt();val display=data.readInt()
      require(task>=0 && display>=0)
      RearDisplayTaskMover.move(context,task,display,true)
      reply?.writeNoException();reply?.writeInt(1)
    } catch(e: Exception){reply?.writeException(IllegalStateException(e.cause?.message ?: e.message ?: "Screen switch refused"))}
    return true
  }
}
