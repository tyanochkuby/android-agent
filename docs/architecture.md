# Architecture

## Execution contract

TypeScript owns the caller. Today the React Native UI submits a timer call or a Google Maps batch. A future TypeScript agent loop can submit one call, inspect its result, and decide what to do next. It can also submit a batch when it already knows the dependencies. The same API supports both flows.

A task has a caller-chosen ID and up to 32 typed calls. The Kotlin boundary validates arguments, dependency cycles, and result references before accepting any work. An app search returns a list of supported installed apps. An `apps.open` or `apps.observe` call may bind that list to its target if it contains exactly one app. Empty and ambiguous searches remain visible to the caller, which can refine the query or pick a specific supported app. `after` provides ordering. A dependency satisfied by `ISSUED` means the request was dispatched. For evidence-dependent decisions, inspect the structured result.

Kotlin accepts one active task and runs up to four ready calls at once, with one foreground action at a time. `FAIL_FAST` stops scheduling after the first failed or unknown outcome is recorded. `CONTINUE_INDEPENDENT` skips dependent calls and lets unrelated calls proceed. Cancelling skips queued and paused calls. Already started actions can finish recording their results. There is no rollback for an external action.

## State and recovery

```text
QUEUED → RUNNING → SUCCEEDED | ISSUED | FAILED | UNKNOWN
   │         │
   └─────→ PAUSED → QUEUED
QUEUED or PAUSED → SKIPPED
```

The executor writes each transition to a private SQLite journal. In particular, `RUNNING` is committed before an adapter can issue a side effect. Submitting an identical request with the same ID returns its saved state. A different request needs a new ID.

Starting a timer uses `AlarmClock.ACTION_SET_TIMER` and can report `ISSUED`. The Clock app owns the countdown and the intent provides no verification callback. Opening a supported app verifies the target package against Android's active Accessibility window where available. The evidence establishes which app had the active window at the recorded time.

When Android kills the process, the app reconciles interrupted work when the verifier reconnects or the caller next reads or sends a command. An interrupted open can be marked successful if its target is currently observable. An interrupted timer or an open without evidence becomes `UNKNOWN`. Inspect the external outcome before intentionally submitting another action. Unstarted calls and interrupted reads require confirmation to continue. The executor does not replay interrupted side effects.

The executor lives in the Android application scope and can record results after the React Native Activity pauses. A foreground handoff, lock, or loss of the confirmed Activity session requires an explicit **Continue task** before another UI action can run. The first slice never injects gestures into the target app. It records the app-window observation during the handoff when available. The user can keep using their phone while read-only calls finish.

## Permissions and workflows

The current allow-all mode covers the typed timer and supported app operations. Debug builds include an opt-in Accessibility service for foreground app evidence. It reads the active window's package and persists only the supported target, whether it matched, and when. Search queries and timer durations are local task inputs. Richer observations would need explicit consent for the task before collection or transmission. This slice sends no observation data to a model provider.

Claude Code dynamic workflows show how JavaScript can branch on results and coordinate callers with a small set of allowed primitives. On Android, a comparable experiment could expose only the typed calls and journal reads, with results checkpointed by call ID so restarting a script does not replay side effects. [Claude dynamic workflows](https://platform.claude.com/cookbook/claude-agent-sdk-08-dynamic-workflows)

Repository-authored TypeScript can use regular control flow around `tasks.submit` and `tasks.read`, or hand a known dependency group to Kotlin. A model-authored workflow would need an isolated runtime with scoped tools, time limits, and a clear lifecycle. The same typed executor API can be the boundary for evaluating that approach later.

The timer and app launches require a resumed Android Agent Activity and an unlocked, interactive screen. For future deferrable work, consider WorkManager. A user-visible foreground service or assistant entry point has separate Android requirements. [Background activity launches](https://developer.android.com/guide/components/activities/secure-bal) · [VoiceInteractionService](https://developer.android.com/reference/android/service/voice/VoiceInteractionService)

## Isolated display feasibility

A normal app can create a private, own-content virtual display. Starting an activity on it also requires that Android allow the activity on that display. `ActivityOptions.setLaunchDisplayId` is available from API 26 and requires the device’s secondary-activity display feature. On API 29 and newer, use `ActivityManager.isActivityStartAllowedOnDisplay` with the actual target intent and display. Android restricts cross-app launches on untrusted virtual displays, so a display owned by the app is insufficient for general third-party UI automation. [ActivityOptions](https://developer.android.com/reference/android/app/ActivityOptions#setLaunchDisplayId(int)) · [AOSP activity launch policy](https://source.android.com/docs/core/display/multi_display/activity-launch)

Trusted display and companion app-streaming paths have separate system permission and association requirements. Explore ADB or Shizuku as opt-in development paths on real hardware. ADB-backed Shizuku runs with shell permissions, which vary by Android build. Wireless setup requires Android 11 or newer, and an ADB-backed service must be started again after reboot. Treat app launch, readable output, input targeting, and concurrent use of the main display as separate pass criteria. Verify each on a stock Pixel 9 for the intended apps and Android build before offering the mode. [AOSP virtual-device sample](https://android.googlesource.com/platform/development/+/35af5c328/samples/VirtualDeviceManager/) · [Shizuku setup](https://shizuku.rikka.app/guide/setup/)

Visual or Accessibility-based integration requires its own review. Google Play prohibits general autonomous planning and execution through its Accessibility API, with a narrow exception for verified accessibility tools serving people with disabilities as their core purpose. Plan the Play build around explicit integrations and narrowly scoped APIs. [Google Play AccessibilityService policy](https://support.google.com/googleplay/android-developer/answer/10964491)
