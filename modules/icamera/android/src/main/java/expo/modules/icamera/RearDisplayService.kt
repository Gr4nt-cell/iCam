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
      // Non-SDK calls stay inside the explicitly authorised Shizuku process.
      val api=Class.forName("android.app.ActivityTaskManager").getMethod("getService").invoke(null)
      val type=Class.forName("android.app.IActivityTaskManager")
      val roots=type.getMethod("getAllRootTaskInfos").invoke(api) as List<*>
      val root=roots.filterNotNull().firstOrNull { info ->
        val cls=info.javaClass
        val rootId=cls.getField("taskId").getInt(info)
        val children=(cls.getField("childTaskIds").get(info) as? IntArray) ?: intArrayOf()
        val top=cls.getField("topActivity").get(info) as? ComponentName
        RearDisplayPolicy.ownRootTask(rootId,task,children,top?.packageName,ownPackage)
      } ?: throw IllegalStateException("iCam must be in the foreground before switching")
      val rootId=root.javaClass.getField("taskId").getInt(root)
      type.getMethod("moveRootTaskToDisplay",Int::class.javaPrimitiveType,Int::class.javaPrimitiveType).invoke(api,rootId,display)
      // Wake only the explicitly chosen display. No system settings or other tasks are changed.
      try { val wake=ProcessBuilder("input","-d",display.toString(),"keyevent","224").start()
        if(!wake.waitFor(2,TimeUnit.SECONDS))wake.destroy()
      } catch (_: Exception) {}
      reply?.writeNoException();reply?.writeInt(1)
    } catch(e: Exception){reply?.writeException(IllegalStateException(e.cause?.message ?: e.message ?: "Screen switch refused"))}
    return true
  }
}
