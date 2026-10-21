#!/usr/bin/env bash
# Boots an x86_64 emulator without third-party actions, then runs the launch smoke test.
set -euo pipefail
SDK="${ANDROID_HOME:-$ANDROID_SDK_ROOT}"
export ANDROID_HOME="$SDK" ANDROID_SDK_ROOT="$SDK"
if ! command -v sdkmanager >/dev/null && [ ! -x "$SDK/cmdline-tools/latest/bin/sdkmanager" ]; then
  echo "Installing Android command-line tools"
  curl -sSL -o /tmp/clt.zip https://dl.google.com/android/repository/commandlinetools-linux-11076708_latest.zip
  mkdir -p "$SDK/cmdline-tools"
  unzip -q -o /tmp/clt.zip -d /tmp/clt
  rm -rf "$SDK/cmdline-tools/latest"
  mv /tmp/clt/cmdline-tools "$SDK/cmdline-tools/latest"
fi
export PATH="$SDK/cmdline-tools/latest/bin:$SDK/emulator:$SDK/platform-tools:$PATH"
yes | sdkmanager --licenses >/dev/null || true
sdkmanager --install "platform-tools" "emulator" "system-images;android-34;google_apis;x86_64" >/dev/null
echo no | avdmanager create avd -n smoke -k "system-images;android-34;google_apis;x86_64" -d pixel_6 --force
nohup emulator -avd smoke -no-window -gpu swiftshader_indirect -no-snapshot -noaudio -no-boot-anim \
  -camera-back emulated -camera-front emulated > /tmp/emulator.log 2>&1 &
adb wait-for-device
for i in $(seq 1 120); do
  [ "$(adb shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" = "1" ] && break
  sleep 3
done
adb shell settings put global window_animation_scale 0 || true
adb shell input keyevent 82 || true
bash .github/scripts/smoke.sh
