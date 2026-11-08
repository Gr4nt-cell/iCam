package expo.modules.icamera

/** Only an explicitly selected, currently attached display may receive the camera task. */
internal object RearDisplayPolicy {
  fun validTarget(target: Int, attached: List<Int>) = target >= 0 && target in attached
  fun ownRootTask(root: Int, task: Int, children: IntArray, topPackage: String?, ownPackage: String) =
    topPackage == ownPackage && ((root == task && children.all { it == task }) || children.size == 1 && children[0] == task)
}
