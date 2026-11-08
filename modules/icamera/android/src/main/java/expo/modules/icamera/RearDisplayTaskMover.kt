package expo.modules.icamera

import android.content.ComponentName
import android.content.Context
import java.util.concurrent.TimeUnit

internal object RearDisplayTaskMover {
  fun move(context: Context, task: Int, display: Int, wake: Boolean) {
    val ownPackage=context.packageName
    // Called only with a granted system task permission or in the authorised Shizuku process.
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
    if(wake) try { val wakeProcess=ProcessBuilder("input","-d",display.toString(),"keyevent","224").start()
      if(!wakeProcess.waitFor(2,TimeUnit.SECONDS))wakeProcess.destroy()
    } catch (_: Exception) {}
  }
}
