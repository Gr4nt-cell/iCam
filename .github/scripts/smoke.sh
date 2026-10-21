#!/usr/bin/env bash
# Installs the APK on the emulator, launches it and reports crashes as annotations.
set +e
APK=$(ls out/*.apk | head -1)
adb install -r -g "$APK"
adb logcat -c
adb shell monkey -p com.gr4nt.icam -c android.intent.category.LAUNCHER 1
sleep 30
adb logcat -d > logcat.txt
# Read whatever text is on screen (shows the in-app error screen if startup failed)
adb shell uiautomator dump /sdcard/ui.xml >/dev/null 2>&1
adb shell cat /sdcard/ui.xml 2>/dev/null | grep -o 'text="[^"]*"' | sed 's/text="//;s/"$//' | grep -v '^$' | head -40 > screen.txt
PID=$(adb shell pidof com.gr4nt.icam | tr -d '\r')
if [ -z "$PID" ]; then STATUS=crashed; else STATUS=running; fi
{
  grep -A50 "FATAL EXCEPTION" logcat.txt | head -70
  grep -E "ReactNativeJS|ReactNative.*(Error|Exception)|libc.*Fatal signal|DEBUG +: " logcat.txt | head -40
  if [ -s screen.txt ]; then echo "---- on screen ----"; cat screen.txt; fi
} > crash.txt
echo "App status after 30s: $STATUS"
if [ -s crash.txt ]; then
  msg=$(sed -e 's/%/%25/g' crash.txt | cut -c1-300 | awk '{printf "%s%%0A", $0}' | cut -c1-60000)
  echo "::warning title=Emulator launch (${STATUS})::${msg}"
else
  echo "::notice title=Emulator launch (${STATUS})::No crash or JS errors logged"
fi
exit 0
