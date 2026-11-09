package expo.modules.icamera

import android.app.Activity
import android.os.Build
import android.view.View
import android.view.ViewGroup

/** UI-only refresh request. Never changes camera capture cadence, screen resolution or system settings. */
internal object UiRefresh {
  fun apply(activity: Activity): Float {
    if(activity.isDestroyed)return 0f
    val display=if(Build.VERSION.SDK_INT>=30)activity.display else @Suppress("DEPRECATION") activity.windowManager.defaultDisplay
    val mode=display?.mode
    val rates=display?.supportedModes?.filter{mode==null || it.physicalWidth==mode.physicalWidth&&it.physicalHeight==mode.physicalHeight}?.map{it.refreshRate} ?: emptyList()
    val target=UiRefreshPolicy.target(rates)
    val window=activity.window
    val attributes=window.attributes
    attributes.preferredRefreshRate=target
    window.attributes=attributes
    if(Build.VERSION.SDK_INT>=35){
      fun request(view: View){
        // The camera surface keeps its independent 30/60 fps producer cadence.
        if(view is ICameraView)return
        view.setRequestedFrameRate(target)
        if(view is ViewGroup)for(i in 0 until view.childCount)request(view.getChildAt(i))
      }
      request(window.decorView)
    }
    return target
  }
}
