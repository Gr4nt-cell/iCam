package expo.modules.icamera

/** Only an explicitly selected, currently attached display may receive the camera task. */
internal object RearDisplayPolicy {
  fun validTarget(target: Int, attached: List<Int>) = target >= 0 && target in attached
  fun ownRootTask(root: Int, task: Int, children: IntArray, topPackage: String?, ownPackage: String) =
    topPackage == ownPackage && ((root == task && children.all { it == task }) || children.size == 1 && children[0] == task)
  fun isRearDisplay(id: Int, type: Int?, name: String, width: Int, height: Int, privateDisplay: Boolean): Boolean {
    if(id==0 || width<=0 || height<=0 || maxOf(width,height)>1800 || minOf(width,height)>1200)return false
    // TYPE_INTERNAL=1. Explicit external/Wi-Fi/overlay/virtual displays never qualify.
    if(type!=null)return type==1
    val label=name.lowercase()
    return privateDisplay && (label.contains("built-in") || label.contains("rear") || label.contains("subscreen") || label.contains("背屏"))
  }
  /** Parse only a root containing this app's task; never move another app's stack. */
  fun rootFromShell(text: String, task: Int, ownPackage: String): Int? {
    var root: Int?=null;var own=false;var foreign=false
    fun found(): Int?=if(own && !foreign)root else null
    for(line in text.lineSequence()) {
      val header=Regex("(?:RootTask|Stack) id=(\\d+)").find(line)
      if(header!=null){found()?.let{return it};root=header.groupValues[1].toIntOrNull();own=false;foreign=false}
      val entry=Regex("taskId=(\\d+)\\s*:\\s*([A-Za-z0-9_.]+)/").find(line)
      if(entry!=null){val id=entry.groupValues[1].toIntOrNull();val pkg=entry.groupValues[2]
        if(pkg!=ownPackage || id!=task)foreign=true else own=true}
      else if(line.contains("taskId="))foreign=true
    }
    return found()
  }

}
