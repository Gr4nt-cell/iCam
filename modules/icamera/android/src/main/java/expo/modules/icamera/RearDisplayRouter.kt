package expo.modules.icamera

import android.app.Activity
import android.app.ActivityManager
import android.app.ActivityOptions
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.ServiceConnection
import android.content.pm.PackageManager
import android.hardware.display.DisplayManager
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.Parcel
import android.view.Display
import android.view.View
import android.view.ViewGroup
import java.util.concurrent.atomic.AtomicBoolean
import rikka.shizuku.Shizuku
import java.util.concurrent.CompletableFuture
import java.util.concurrent.TimeUnit

internal object RearDisplayRouter {
  private val main=Handler(Looper.getMainLooper())
  private var keptRearAwake=false
  private val moving=AtomicBoolean(false)
  val isMoving: Boolean get()=moving.get()
  private fun <T> onMain(delay: Long=0, block: ()->T): T {
    check(Looper.myLooper()!=Looper.getMainLooper()) { "Display moves must use the background queue" }
    val result=CompletableFuture<T>()
    main.postDelayed({try{result.complete(block())}catch(e:Exception){result.completeExceptionally(e)}},delay)
    return result.get(4,TimeUnit.SECONDS)
  }
  private fun cameras(view: View, block: (ICameraView)->Unit) {
    if(view is ICameraView)block(view)
    if(view is ViewGroup)for(i in 0 until view.childCount)cameras(view.getChildAt(i),block)
  }
  private fun current(activity: Activity)=if(Build.VERSION.SDK_INT>=30)activity.display?.displayId ?: 0 else @Suppress("DEPRECATION") activity.windowManager.defaultDisplay.displayId
  private fun rear(display: Display): Boolean {
    val metrics=android.util.DisplayMetrics();@Suppress("DEPRECATION") display.getRealMetrics(metrics)
    val type=try{Display::class.java.getMethod("getType").invoke(display) as? Int}catch(_:Exception){null}
    return RearDisplayPolicy.isRearDisplay(display.displayId,type,display.name,metrics.widthPixels,metrics.heightPixels,(display.flags and Display.FLAG_PRIVATE)!=0)
  }
  private fun displays(activity: Activity)=(activity.getSystemService(Context.DISPLAY_SERVICE) as DisplayManager).displays.filter{it.displayId==0||rear(it)}
  private fun ready()=try{Shizuku.pingBinder()}catch(_:Exception){false}
  private fun granted()=try{ready() && Shizuku.checkSelfPermission()==PackageManager.PERMISSION_GRANTED}catch(_:Exception){false}

  private fun systemAccess(activity: Activity)=activity.checkSelfPermission("android.permission.MANAGE_ACTIVITY_TASKS")==PackageManager.PERMISSION_GRANTED

  fun status(activity: Activity): Map<String,Any> = mapOf(
    "currentId" to current(activity), "shizukuRunning" to ready(), "shizukuGranted" to granted(), "systemAccess" to systemAccess(activity), "rootGranted" to RearDisplayRoot.granted,
    "displays" to displays(activity).map { d ->
      val metrics=android.util.DisplayMetrics();@Suppress("DEPRECATION") d.getRealMetrics(metrics)
      mapOf("id" to d.displayId,"name" to if(d.displayId==Display.DEFAULT_DISPLAY)"Front screen" else d.name,
        "width" to metrics.widthPixels,"height" to metrics.heightPixels,"isRear" to rear(d))
    })

  fun requestAccess(): String {
    if(!ready())return "notRunning"
    if(granted())return "granted"
    if(Shizuku.shouldShowRequestPermissionRationale())return "denied"
    Shizuku.requestPermission(7014)
    return "requested"
  }

  /** Quiesce the camera on main, move only this task, then rebuild surfaces on its live activity. */
  fun move(activity: Activity,target: Int,useShizuku: Boolean,useRoot: Boolean = false,
    currentActivity: ()->Activity? = { activity }): Map<String,Any> {
    if(!moving.compareAndSet(false,true))return mapOf("moved" to false,"message" to "A screen switch is already in progress")
    try {
      val already=onMain {
        require(RearDisplayPolicy.validTarget(target,displays(activity).map{it.displayId})) { "That screen is no longer connected" }
        val same=current(activity)==target
        if(!same)cameras(activity.window.decorView){it.pauseForDisplaySwitch()}
        same
      }
      if(already)return mapOf("moved" to true)
      fun verify(): Boolean {
        repeat(8){
          val moved=onMain(250){
            val live=currentActivity()?.takeUnless{it.isDestroyed||it.isFinishing} ?: return@onMain false
            if(current(live)!=target)return@onMain false
            if(target!=0){live.window.addFlags(android.view.WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);keptRearAwake=true}
            else if(keptRearAwake){live.window.clearFlags(android.view.WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);keptRearAwake=false}
            try{live.requestedOrientation=if(target==0)android.content.pm.ActivityInfo.SCREEN_ORIENTATION_PORTRAIT else android.content.pm.ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED}catch(_:Exception){}
            if(Build.VERSION.SDK_INT>=27)live.setTurnScreenOn(target!=0)
            true
          }
          if(moved)return true
        }
        return false
      }
      var detail=""
      // Move the existing task first when access is available; avoid relaunching the camera activity.
      if(systemAccess(activity))try{
        RearDisplayTaskMover.move(activity,activity.taskId,target,false)
        if(verify())return mapOf("moved" to true)
      }catch(e:Exception){detail="System route: "+(e.cause?.message ?: e.message ?: "refused")}
      if(useShizuku && granted())try{
        movePrivileged(activity,target)
        if(verify())return mapOf("moved" to true)
      }catch(e:Exception){detail="Shizuku route: "+(e.cause?.message ?: e.message ?: "refused")}
      if(useRoot)try{
        RearDisplayRoot.move(activity,target)
        if(verify())return mapOf("moved" to true)
      }catch(e:Exception){detail="Root route: "+(e.message ?: "refused")}
      // Public front-display return still works if Shizuku has stopped.
      val intent=Intent(activity,activity.javaClass).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
      val allowed=onMain {Build.VERSION.SDK_INT<29 || (activity.getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager).isActivityStartAllowedOnDisplay(activity,target,intent)}
      if(allowed)try{
        onMain {activity.startActivity(intent,ActivityOptions.makeBasic().setLaunchDisplayId(target).toBundle())}
        if(verify())return mapOf("moved" to true)
      }catch(e:Exception){detail=e.cause?.message ?: e.message ?: "Screen switch refused"}
      return mapOf("moved" to false,"needsShizuku" to true,"message" to
        (detail.ifEmpty { "The phone blocked switching. Enable Shizuku or choose the root fallback." }))
    } catch(e:Exception) {
      return mapOf("moved" to false,"message" to (e.cause?.message ?: e.message ?: "Screen switch failed"))
    } finally {
      moving.set(false)
      try{onMain {
        val live=currentActivity()
        if(live!=null&&!live.isDestroyed){try{UiRefresh.apply(live)}catch(_:Exception){};cameras(live.window.decorView){it.resumeAfterDisplaySwitch()}}
      }}catch(_:Exception){}
    }
  }

  private fun movePrivileged(activity: Activity,target: Int) {
    val binder=CompletableFuture<IBinder>()
    val args=Shizuku.UserServiceArgs(ComponentName(activity,RearDisplayService::class.java))
      .daemon(false).processNameSuffix("rear_screen").tag("icam-rear-screen").version(1)
    val connection=object: ServiceConnection {
      override fun onServiceConnected(name: ComponentName,service: IBinder){binder.complete(service)}
      override fun onServiceDisconnected(name: ComponentName){binder.completeExceptionally(IllegalStateException("Shizuku disconnected"))}
    }
    main.post {try{Shizuku.bindUserService(args,connection)}catch(e:Exception){binder.completeExceptionally(e)}}
    try{
      val service=binder.get(8,TimeUnit.SECONDS)
      val data=Parcel.obtain();val reply=Parcel.obtain()
      try{data.writeInterfaceToken(RearDisplayService.DESCRIPTOR);data.writeInt(activity.taskId);data.writeInt(target)
        check(service.transact(RearDisplayService.MOVE,data,reply,0));reply.readException();check(reply.readInt()==1)
      }finally{data.recycle();reply.recycle()}
    }finally{main.post{try{Shizuku.unbindUserService(args,connection,true)}catch(_:Exception){}}}
  }
}
