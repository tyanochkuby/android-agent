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

When Android kills the process, the app reconciles interrupted work when the verifier reconnects or the caller next reads or sends a command. An interrupted timer or app launch becomes `UNKNOWN`. An app launch can include window evidence collected within a one-second window while the verifier reconnects. That observation describes the active app at recovery time. Only recorded successful or issued steps satisfy dependencies. Inspect the external outcome before intentionally submitting another action. Unstarted calls and interrupted reads require confirmation to continue. The executor does not replay interrupted side effects.

The journal doubles as a device-local record of action calls. Each task keeps its ID, its submitted steps with their exact inputs, and the recorded state of each step. `tasks.list(limit, before)` pages through tasks in submission order, newest first, up to 20 at a time. Pass the last task ID from a page as `before` to read the next one. Listing reconciles interrupted work using the executor’s recovery rules and never dispatches actions. Typed adapters interpret their own steps. To repeat an earlier call, submit its inputs under a new task ID.

## Conversation

The debug agent keeps one device-local conversation in the task database. A prompt is saved as a `RUNNING` turn before inference, and the final reply or error is saved against the same turn as `COMPLETED` or `FAILED`. Turns run in JavaScript, so a new JavaScript runtime marks any turn still running as `INTERRUPTED` and never replays it. Tasks submitted by agent tools record the turn ID, so a turn shows the task journal's own evidence for its calls. UI workflow actions are not journaled and are not linked. Replies from screen-assisted turns are saved; observations are not.

`conversation.read(limit, before)` pages through turns newest first, like `tasks.list`. Failed, interrupted and running turns stay visible but are not sent to the model. The schema version stays at 1 so earlier builds can open the database, and rows from the earlier `conversation` table are copied once and left in place.

If saving a turn's reply or error fails, the app keeps the outcome and saves it again before the next prompt starts. Saving the same outcome twice succeeds, so a save that landed without an acknowledgement is safe to repeat. Inference and tools never run again for that turn.

Sharing saved history with the companion requires opt-in on each connection. The companion validates the sign-in session on every inference request and invalidates it when sign-in starts again. Screen-assisted replies can be included when history is shared. Model input starts with the same instructions on every request, then the latest checkpoint summary, then every completed turn after the turn the checkpoint covers, word for word. Text-only requests between compactions extend the previous initial request, preserving its reusable prefix. Screen-sharing and tool-loop messages are turn-local and can shorten the prefix a later request can reuse. The instructions state that screen sharing is off by default. A request with screen sharing on adds the screen tools after its prompt, and the native tools still refuse screen actions for other requests. Turn-local screen observations and tool results are never stored.

`contextBudget` in `src/agent.ts` sets the sizes in characters of the request body, estimated at about four characters per token. It does not use a tokenizer. A request may use up to 64,000 characters, and 24,000 are kept free for the current prompt, tool results and the reply. Every model call, including each step of the tool loop and the summary request, is checked against the limit first. If the current request alone is too large, or tool results push it over, the turn fails before that call without running more tools. When the stored part passes 32,000 characters, the app sends that same input plus a summary request through the normal inference route. Only a lone `finish` reply counts, and no tools run. The summary and its coverage are saved in one transaction, and coverage only moves forward. If summarizing or saving fails, the previous checkpoint stays. If the stored part still exceeds the limit, the request sends the newest turns that fit and leaves the checkpoint unchanged. Checkpoints are not yet triggered by idle time or cache expiry.

The executor lives in the Android application scope and can record results after the React Native Activity pauses. A foreground handoff, lock, or loss of window focus in the confirmed Activity requires an explicit **Continue task** before another UI action can run. The first slice never injects gestures into the target app. It records the app-window observation during the handoff when available. The user can keep using their phone while read-only calls finish.

## Permissions and workflows

The current allow-all mode covers the typed timer and supported app operations. Debug builds include an opt-in Accessibility service for foreground app evidence. It reads the active window's package and persists only the supported target, whether it matched, and when. Search queries and timer durations are local task inputs. Richer observations would need explicit consent for the task before collection or transmission. This slice sends no observation data to a model provider.

Claude Code dynamic workflows show how JavaScript can branch on results and coordinate callers with a small set of allowed primitives. On Android, a comparable experiment could expose only the typed calls and journal reads, with results checkpointed by call ID so restarting a script does not replay side effects. [Claude dynamic workflows](https://platform.claude.com/cookbook/claude-agent-sdk-08-dynamic-workflows)

Repository-authored TypeScript can use regular control flow around `tasks.submit` and `tasks.read`, or hand a known dependency group to Kotlin. A model-authored workflow would need an isolated runtime with scoped tools, time limits, and a clear lifecycle. The same typed executor API can be the boundary for evaluating that approach later.

The timer and app launches require a resumed Android Agent Activity and an unlocked, interactive screen. For future deferrable work, consider WorkManager. A user-visible foreground service or assistant entry point has separate Android requirements. [Background activity launches](https://developer.android.com/guide/components/activities/secure-bal) · [VoiceInteractionService](https://developer.android.com/reference/android/service/voice/VoiceInteractionService)

## Foreground UI workflows

The sideloaded debug build can start a TypeScript workflow against a selected Android package. The same Kotlin adapter opens the app, reads a bounded Accessibility snapshot, and requests click or text-entry actions supported by the selected element. On Android 13 and later the launch uses a package-scoped intent sender. On older versions the target must already be visible to the app. The Maps demo's selectors live in TypeScript.

Each action consumes its snapshot. Before dispatch, Kotlin checks the active package, window, target, and matched label. A stale result means the action was never issued, so the caller can re-observe and retry its selection. An accepted action is a dispatch receipt. The workflow checks the next screen for evidence of the result.

A session is started from Android Agent while it owns the foreground and lasts at most one minute. The expected target-app handoff lets the script continue. A detected switch away from the app, a reported touch interaction, or an unavailable screen ends the session or blocks dispatch. Touch reporting depends on Android and the active accessibility configuration. Return to Android Agent to start again. Only explicitly started workflows receive snapshots. Snapshot data stays in memory, with no provider transmission. The step journal still covers task batches. UI workflow sessions end on process death and scripts do not replay automatically.

## Isolated display feasibility

A normal app can create a private, own-content virtual display. Starting an activity on it also requires that Android allow the activity on that display. `ActivityOptions.setLaunchDisplayId` is available from API 26 and requires the device’s secondary-activity display feature. On API 29 and newer, use `ActivityManager.isActivityStartAllowedOnDisplay` with the actual target intent and display. Android restricts cross-app launches on untrusted virtual displays, so a display owned by the app is insufficient for general third-party UI automation. [ActivityOptions](https://developer.android.com/reference/android/app/ActivityOptions#setLaunchDisplayId(int)) · [AOSP activity launch policy](https://source.android.com/docs/core/display/multi_display/activity-launch)

Trusted display and companion app-streaming paths have separate system permission and association requirements. Explore ADB or Shizuku as opt-in development paths on real hardware. ADB-backed Shizuku runs with shell permissions, which vary by Android build. Wireless setup requires Android 11 or newer, and an ADB-backed service must be started again after reboot. Treat app launch, readable output, input targeting, and concurrent use of the main display as separate pass criteria. Verify each on a stock Pixel 9 for the intended apps and Android build before offering the mode. [AOSP virtual-device sample](https://android.googlesource.com/platform/development/+/35af5c328/samples/VirtualDeviceManager/) · [Shizuku setup](https://shizuku.rikka.app/guide/setup/)

Visual or Accessibility-based integration requires its own review. Google Play prohibits general autonomous planning and execution through its Accessibility API, with a narrow exception for verified accessibility tools serving people with disabilities as their core purpose. Plan the Play build around explicit integrations and narrowly scoped APIs. [Google Play AccessibilityService policy](https://support.google.com/googleplay/android-developer/answer/10964491)
