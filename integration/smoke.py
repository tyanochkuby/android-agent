"""Run the real React Native workflow against an installed emulator fixture."""
import os
import re
import subprocess
import time
import xml.etree.ElementTree as ET

APP = "io.github.tyanochkuby.androidagent"
FIXTURE = "io.github.tyanochkuby.uifixture"
SERIAL = os.environ.get("ANDROID_SERIAL", "emulator-5554")
SERVICE = f"{APP}/.tasks.WindowObserver"

if not re.fullmatch(r"emulator-\d+", SERIAL):
    raise SystemExit("This test requires a disposable Android emulator.")


def adb(*args):
    return subprocess.check_output(["adb", "-s", SERIAL, *args], text=True, timeout=20)


def find(label):
    deadline = time.monotonic() + 35
    while time.monotonic() < deadline:
        try:
            output = adb("shell", "uiautomator", "dump", "/sdcard/agent-integration.xml")
            if "dumped to" not in output:
                continue
            tree = ET.fromstring(adb("shell", "cat", "/sdcard/agent-integration.xml"))
        except (subprocess.CalledProcessError, subprocess.TimeoutExpired):
            continue
        for node in tree.iter("node"):
            visible_label = node.get("text", "") or node.get("content-desc", "")
            if visible_label.startswith("Integration failed:"):
                raise AssertionError(visible_label)
            if visible_label.casefold() == label.casefold():
                return node
        time.sleep(0.25)
    raise AssertionError(f"Did not find {label!r} on the emulator.")


def wait_for_state(read, matches, description):
    deadline = time.monotonic() + 35
    while time.monotonic() < deadline:
        if matches(read()):
            return
        time.sleep(0.25)
    raise AssertionError(f"Timed out waiting for {description}.")


def settings(key, value):
    if value == "null":
        adb("shell", "settings", "delete", "secure", key)
    else:
        adb("shell", "settings", "put", "secure", key, value)


def main():
    keys = ("enabled_accessibility_services", "accessibility_enabled")
    previous = {key: adb("shell", "settings", "get", "secure", key).strip() for key in keys}
    try:
        adb("shell", "am", "force-stop", FIXTURE)
        adb("shell", "am", "force-stop", APP)
        settings(keys[0], "null")
        adb("shell", "am", "start", "-n", f"{APP}/.MainActivity")
        button = find("Run fixture workflow")
        settings(keys[0], SERVICE)
        settings(keys[1], "1")
        wait_for_state(
            lambda: adb("shell", "dumpsys", "accessibility"),
            lambda state: any(
                "Android Agent window verification" in line
                for line in state.splitlines() if "Bound services:" in line
            ),
            "the Accessibility service",
        )
        left, top, right, bottom = map(int, re.findall(r"\d+", button.attrib["bounds"]))
        pid = adb("shell", "pidof", APP).strip()
        adb("shell", "input", "tap", str((left + right) // 2), str((top + bottom) // 2))
        wait_for_state(
            lambda: adb("shell", "dumpsys", "activity", "activities"),
            lambda state: any(
                "com.android.settings/" in line
                for line in state.splitlines() if "topResumedActivity=" in line
            ),
            "the Settings activity launched from the fixture",
        )

        def workflow_passed(logs):
            if "ANDROID_AGENT_INTEGRATION_FAILED" in logs:
                raise AssertionError("The workflow reported a failure.")
            return "ANDROID_AGENT_INTEGRATION_PASSED" in logs

        wait_for_state(
            lambda: adb("logcat", "-d", f"--pid={pid}", "-s", "ReactNativeJS"),
            workflow_passed,
            "the workflow result while Settings is open",
        )
        adb("shell", "am", "start", "-n", f"{APP}/.MainActivity")
        find("Integration passed")
        print("Fixture workflow passed through the React Native bridge and Accessibility.")
    finally:
        for key, value in previous.items():
            settings(key, value)


if __name__ == "__main__":
    main()
