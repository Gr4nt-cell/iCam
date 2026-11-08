package expo.modules.icamera

import android.app.Activity
import java.util.concurrent.TimeUnit

/** Explicitly opted-in su fallback. All commands are fixed; IDs are validated integers. */
internal object RearDisplayRoot {
  @Volatile var granted=false
    private set
  private fun command(text: String, timeout: Long = 5): String {
    val process=try{ProcessBuilder("su","-c",text).redirectErrorStream(true).start()}catch(_:java.io.IOException){throw IllegalStateException("Root is unavailable. Use Shizuku or a privileged system build.")}
    process.outputStream.close()
    val output=StringBuilder()
    val reader=Thread {
      try{process.inputStream.bufferedReader().use { input ->
        val buffer=CharArray(1024)
        while(true){val n=input.read(buffer);if(n<0)break
          synchronized(output){if(output.length+n<=65536)output.append(buffer,0,n)}
        }
      }}catch(_:Exception){}
    }.apply{isDaemon=true;start()}
    if(!process.waitFor(timeout,TimeUnit.SECONDS)){process.destroyForcibly();throw IllegalStateException("Root access timed out")}
    reader.join(500)
    val result=synchronized(output){output.toString()}
    check(process.exitValue()==0){"Root access or the screen command was denied"}
    return result
  }
  fun move(activity: Activity,target: Int) {
    require(target>=0 && activity.taskId>=0)
    granted=command("id -u",15).trim()=="0"
    check(granted){"The root manager did not grant root access"}
    val root=RearDisplayPolicy.rootFromShell(command("am stack list"),activity.taskId,activity.packageName)
      ?: throw IllegalStateException("Could not identify iCam’s own fullscreen task")
    command("am display move-stack $root $target")
    try{command("input -d $target keyevent 224")}catch(_:Exception){}
  }
}
