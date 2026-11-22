#!/usr/bin/env bash
set -euo pipefail

export ANDROID_SERIAL=${ANDROID_SERIAL:-emulator-5554}
if [[ ! $ANDROID_SERIAL =~ ^emulator-[0-9]+$ ]]; then
  echo 'Select a disposable Android emulator.' >&2
  exit 1
fi
ANDROID_AGENT_INTEGRATION=1 node node_modules/react-native/cli.js start --host 127.0.0.1 --port 8081 >/tmp/android-agent-integration-metro.log 2>&1 &
metro_pid=$!
cleanup() {
  adb logcat -d > /tmp/android-agent-integration-logcat.log || true
  kill "$metro_pid" 2>/dev/null || true
}
trap cleanup EXIT
# The app's debug server port is 8081 on the emulator.
adb reverse tcp:8081 tcp:8081
adb install -r android/app/build/outputs/apk/debug/app-debug.apk
adb install -r android/fixture/build/outputs/apk/debug/fixture-debug.apk
for ((attempt=0; attempt<30; attempt++)); do
  if curl --silent --fail http://127.0.0.1:8081/status | grep -q packager-status:running; then
    python3 integration/smoke.py
    exit
  fi
  sleep 1
done
echo 'Integration Metro did not start.' >&2
exit 1
