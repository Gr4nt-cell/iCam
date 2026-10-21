#!/usr/bin/env bash
# Boots an x86_64 emulator (with hard timeouts), then runs the launch smoke test.
set -uo pipefail
SDK="${ANDROID_HOME:-$ANDROID_SDK_ROOT}"
export ANDROID_HOME="$SDK" ANDROID_SDK_ROOT="$SDK"

note() { echo "==> $*"; }
fail() {
  echo "FAILED: $*"
  echo "---- emulator log ----"
  tail -40 /tmp/emulator.log 2>/dev/null
  exit 1
}

if [ ! -x "$SDK/cmdline-tools/latest/bin/sdkmanager" ]; then
  note "Installing command-line tools"
  curl -sSL -o /tmp/clt.zip https://dl.google.com/android/repository/commandlinetools-linux-13114758_latest.zip || fail "download cmdline-tools"
  rm -rf /tmp/clt && unzip -q /tmp/clt.zip -d /tmp/clt
  mkdir -p "$SDK/cmdline-tools" && rm -rf "$SDK/cmdline-tools/latest"
  mv /tmp/clt/cmdline-tools "$SDK/cmdline-tools/latest"
fi
export PATH="$SDK/cmdline-tools/latest/bin:$SDK/emulator:$SDK/platform-tools:$PATH"
export ANDROID_USER_HOME="$HOME/.android" ANDROID_AVD_HOME="$HOME/.android/avd"
mkdir -p "$ANDROID_AVD_HOME"

note "Disk: $(df -h / | tail -1)"
(yes || true) | sdkmanager --licenses >/dev/null 2>&1
timeout 600 sdkmanager --install "platform-tools" "emulator" "system-images;android-34;google_apis;x86_64" \
  > /tmp/sdk.log 2>&1 || { tail -20 /tmp/sdk.log; fail "sdkmanager install"; }
ls -la /dev/kvm || note "no /dev/kvm"

echo no | avdmanager create avd -n smoke -k "system-images;android-34;google_apis;x86_64" -d pixel_6 --force \
  > /tmp/avd.log 2>&1 || { cat /tmp/avd.log; fail "avd create"; }
emulator -list-avds | grep -q smoke || { cat /tmp/avd.log; ls -R "$HOME/.android" | head; fail "avd not found after create"; }

note "Starting emulator"
nohup emulator -avd smoke -no-window -gpu swiftshader_indirect -no-snapshot -noaudio -no-boot-anim \
  -accel on -camera-back emulated -camera-front emulated > /tmp/emulator.log 2>&1 &

timeout 240 adb wait-for-device || fail "device never appeared"
booted=0
for i in $(seq 1 100); do
  if [ "$(adb shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" = "1" ]; then booted=1; break; fi
  sleep 3
done
[ "$booted" = 1 ] || fail "boot did not complete"
note "Booted"
adb shell input keyevent 82 || true
timeout 300 bash .github/scripts/smoke.sh || fail "smoke test"
