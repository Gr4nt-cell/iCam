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
import rikka.shizuku.Shizuku
import java.util.concurrent.CompletableFuture
import java.util.concurrent.TimeUnit

internal object RearDisplayRouter {
  private val main=Handler(Looper.getMainLooper())
  private fun current(activity: Activity)=if(Build.VERSION.SDK_INT>=30)activity.display?.displayId ?: 0 else @Suppress("DEPRECATION") activity.windowManager.defaultDisplay.displayId
  private fun displays(activity: Activity)=(activity.getSystemService(Context.DISPLAY_SERVICE) as DisplayManager).displays.toList()
  private fun ready()=try{Shizuku.pingBinder()}catch(_:Exception){false}
  private fun granted()=try{ready() && Shizuku.checkSelfPermission()==PackageManager.PERMISSION_GRANTED}catch(_:Exception){false}

  fun status(activity: Activity): Map<String,Any> = mapOf(
    "currentId" to current(activity), "shizukuRunning" to ready(), "shizukuGranted" to granted(),
    "displays" to displays(activity).map { d ->
      val metrics=android.util.DisplayMetrics();@Suppress("DEPRECATION") d.getRealMetrics(metrics)
      mapOf("id" to d.displayId,"name" to if(d.displayId==Display.DEFAULT_DISPLAY)"Front screen" else d.name,
        "width" to metrics.widthPixels,"height" to metrics.heightPixels)
    })

  fun requestAccess(): String {
    if(!ready())return "notRunning"
    if(granted())return "granted"
    if(Shizuku.shouldShowRequestPermissionRationale())return "denied"
    Shizuku.requestPermission(7014)
    return "requested"
  }

  /** Called on Expo's background queue; main-thread operations never block the UI. */
  fun move(activity: Activity,target: Int,useShizuku: Boolean): Map<String,Any> {
    require(RearDisplayPolicy.validTarget(target,displays(activity).map{it.displayId})) { "That screen is no longer connected" }
    if(current(activity)==target)return mapOf("moved" to true)
    val intent=Intent(activity,activity.javaClass).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
    val allowed=Build.VERSION.SDK_INT<29 || (activity.getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager).isActivityStartAllowedOnDisplay(activity,target,intent)
    fun verify(): Boolean {
      val result=CompletableFuture<Boolean>()
      main.postDelayed({result.complete(!activity.isDestroyed && current(activity)==target)},700)
      return result.get(3,TimeUnit.SECONDS)
    }
    // Returning to the public front display must not depend on Shizuku staying alive.
    if(allowed){
      val started=CompletableFuture<Boolean>()
      main.post {try{activity.startActivity(intent,ActivityOptions.makeBasic().setLaunchDisplayId(target).toBundle());started.complete(true)}catch(_:Exception){started.complete(false)}}
      if(started.get(3,TimeUnit.SECONDS) && verify())return mapOf("moved" to true)
    }
    if(useShizuku && granted()){
      movePrivileged(activity,target)
      if(verify())return mapOf("moved" to true)
    }
    return mapOf("moved" to false,"needsShizuku" to true,"message" to "The phone has not allowed the screen switch. Enable Shizuku access if this display is restricted.")
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
