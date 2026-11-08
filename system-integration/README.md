# Optional privileged ROM integration

Install the built APK as /system/priv-app/iCam/iCam.apk with the permission and sysconfig XML files in this folder on the same system partition, then reboot. These are ROM integration inputs; the app does not modify the system partition or grant itself permissions. Preserve the normal APK signing identity when updating an installed iCam.

The permission allowlist grants the requested MANAGE_ACTIVITY_TASKS privilege to the privileged package. The sysconfig entry permits its limited hidden task-manager calls on system builds. Merely placing an APK under /system/app is insufficient. Vendor partitions, signing policy, hidden-API policy and HyperOS task restrictions can impose additional OEM requirements. The app checks the actual granted permission instead of assuming that every system app is privileged.

Once properly provisioned, the app tries its own privileged task-move route before Shizuku or root. Runtime su / Shizuku is unnecessary for that route. This configuration has not been installed or tested on a Xiaomi ROM here. Do not add unrelated signature permissions to this allowlist.
