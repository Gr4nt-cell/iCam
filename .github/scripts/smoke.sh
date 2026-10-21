#!/usr/bin/env bash
# Installs the APK on the emulator, launches it and reports crashes as annotations.
set +e
APK=$(ls out/*.apk | head -1)
adb install -r -g "$APK"
adb logcat -c
adb shell monkey -p com.gr4nt.icam -c android.intent.category.LAUNCHER 1
sleep 45
adb shell input keyevent KEYCODE_ENTER >/dev/null 2>&1; sleep 2
adb logcat -d > logcat.txt
# Read whatever text is on screen (shows the in-app error screen if startup failed)
adb shell uiautomator dump /sdcard/ui.xml >/dev/null 2>&1
adb shell cat /sdcard/ui.xml 2>/dev/null | grep -o 'text="[^"]*"' | sed 's/text="//;s/"$//' | grep -v '^$' | head -40 > screen.txt
PID=$(adb shell pidof com.gr4nt.icam | tr -d '\r')
if [ -z "$PID" ]; then STATUS=crashed; else STATUS=running; fi
PIDS=$(grep -oE "Start proc [0-9]+:com.gr4nt.icam" logcat.txt | grep -oE "[0-9]+" | tr '\n' '|' | sed 's/|$//')
{
  if [ -s screen.txt ]; then echo "---- on screen ----"; cat screen.txt; fi
  # only crashes from iCam itself (other emulator apps crash during boot)
  grep -A40 -E "FATAL EXCEPTION" logcat.txt | grep -B2 -A38 "Process: com.gr4nt.icam" | head -60
  grep -E "ReactNativeJS|ReactNative.*(Error|Exception)" logcat.txt | head -25
  grep -E "Fatal signal.*com.gr4nt.icam|ICamera|CameraX.*(Error|Exception)" logcat.txt | head -15
} > crash.txt
echo "App status after 30s: $STATUS"
if [ -s crash.txt ]; then
  msg=$(sed -e 's/%/%25/g' crash.txt | cut -c1-300 | awk '{printf "%s%%0A", $0}' | cut -c1-60000)
  echo "::warning title=Emulator launch (${STATUS})::${msg}"
else
  echo "::notice title=Emulator launch (${STATUS})::No crash or JS errors logged"
fi
exit 0
