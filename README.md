# Android Agent

Android Agent is an Android-first assistant project. The demo includes two local tasks and a debug-only prompt runner. **Start timer** sends a timer request to Clock. **Find and open Google Maps** looks up an installed app and uses the typed search result to open it. Both show their saved step status when you return to Android Agent. Neither needs an account or model provider.

See [the architecture and Android constraints](docs/architecture.md) for the Kotlin executor contract, recovery behavior, and app verification.

## Development setup

- Node 24 LTS and npm. The tested Node version is pinned in `.nvmrc`.
- JDK 17 and the Android SDK command-line tools or Android Studio.
- Android SDK Platform 37.0, Build Tools 37.0.0, NDK 27.1.12297006, CMake 3.22.1, and Platform Tools.
- An Android 7.0 (API 24) or newer device or emulator with a clock app that handles `ACTION_SET_TIMER`. The app targets API 36.

From the project root, set `JAVA_HOME` and `ANDROID_HOME` for your installation. For example, a macOS setup with the Android Studio SDK uses:

```sh
nvm use
export JAVA_HOME="$(/usr/libexec/java_home -v 17)"
export ANDROID_HOME="$HOME/Library/Android/sdk"
export PATH="$JAVA_HOME/bin:$ANDROID_HOME/platform-tools:$ANDROID_HOME/cmdline-tools/latest/bin:$PATH"
sdkmanager "platform-tools" "platforms;android-37.0" "build-tools;37.0.0" \
  "ndk;27.1.12297006" "cmake;3.22.1"
npm ci
```

With the Homebrew command-line tools on Apple Silicon, the SDK may instead be at `/opt/homebrew/share/android-commandlinetools`. Use `sdkmanager --licenses` if the SDK prompts for license acceptance.

Run Metro with `npm start`. With an emulator booted or a USB-debuggable device connected, check `adb devices` and run `npm run android` in a second terminal. Android Studio’s Device Manager can create an API 36 Google APIs emulator that includes Clock.

If the app loads but Fast Refresh disconnects on the emulator, run `adb reverse tcp:8081 tcp:8081`. In React Native’s developer settings, set **Debug server host & port for device** to `127.0.0.1:8081` and reload the app.

## Prompt runner

The debug app pairs over USB with a local Node.js companion. **Sign in with ChatGPT** opens OpenAI's sign-in page in the companion computer's browser. Approve ChatGPT plan usage there. The companion uses OpenAI's open-source DevKit to authorize and stream inference through the public Responses API. The phone gets model replies and runs tools locally. OAuth credentials stay in the companion process and signing in again is required after restarting it. [OpenAI sign-in guide](https://developers.openai.com/siwc/token-sharing-open-source) · [Inference contract](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference)

OpenAI documents the open-source flow with a loopback callback and provides a local Node.js DevKit. The POC uses that companion flow for the Android button. Codex App Server also documents its own managed ChatGPT login and an experimental dynamic-tool interface for host-side integrations. [Registration and sign-in](https://developers.openai.com/siwc/token-sharing-open-source/sign-in) · [Codex App Server](https://developers.openai.com/codex/app-server)

Build the DevKit in a separate checkout. It is distributed under its own [license](https://github.com/openai/sign-in-with-chatgpt-devkit/blob/main/LICENSE).

```sh
git clone https://github.com/openai/sign-in-with-chatgpt-devkit.git
cd sign-in-with-chatgpt-devkit
git checkout 0a36fefeb913055c8c7a1a29b63d82b96b2e841a
npm ci --ignore-scripts
npm run build -w @siwc/local
```

From the Android Agent checkout, start the companion and forward its loopback port to the device.

```sh
node companion/server.mjs /path/to/sign-in-with-chatgpt-devkit
adb reverse tcp:8765 tcp:8765
```

1. In **Ask Android Agent**, enter the pairing code printed by the companion, then tap **Sign in with ChatGPT**. After consent in the computer's browser, tap **Check connection**.
2. Try `Set a timer for 2 minutes and 17 seconds`. Check the countdown in Clock. The app can confirm that it sent the intent to Clock.
3. To use Maps, first enable **Android Agent window verification** in **Accessibility settings**. Return to Android Agent, enter `In Google Maps, open directions to Warsaw Central Station and stop at the route preview`, and opt in to screen sharing for that prompt. Keep Maps in the foreground while the agent works, then return to Android Agent to read its reply. The foreground UI session expires after one minute.

The model can run an ordered sequence of tools and use the results to decide what to do next. The POC supports one timer request and one foreground UI session per prompt. UI actions resolve a uniquely matching control on the current screen. Prompts go to the model. Visible labels and controls from the selected app are shared only when you opt in for that run. Clock works with screen sharing off. The companion uses the first model in the account's eligible catalog.

## Checks

```sh
npm run lint
npm run typecheck
npm test -- --runInBand
(cd android && ./gradlew :app:testDebugUnitTest :app:assembleDebug :app:lintDebug)
```

## Device smoke test

Use a sideloaded debug build on a stock Pixel 9 with Clock and Google Maps installed. An API 36 Google APIs emulator with those apps can exercise the same flow.

1. Pick **1 min** and tap **Start timer**. Open Clock to confirm the countdown and dismiss the test timer. In Android Agent, the saved step reads `issued`. [Android timer intent reference](https://developer.android.com/reference/android/provider/AlarmClock#ACTION_SET_TIMER)
2. Tap **Accessibility settings**, enable **Android Agent window verification**, and return to Android Agent. Android may require allowing restricted settings for the sideloaded app before it can enable the service.
3. Tap **Find and open Google Maps**. Once Maps is visible, give the observation a moment to complete, then return to Android Agent. The search should list Google Maps and the open step should report **Google Maps window verified**. With the service disabled, the open step should report `issued`.
4. Force-stop and reopen Android Agent. The latest task should still be visible. A recorded `issued` or verified action should retain that status without another launch.

## Android integration tests

The **Nightly Android integration** workflow runs on `main` at 02:23 UTC and can also be launched from the Actions tab. It uses a disposable API 36 emulator to exercise text entry, stale-selection rejection, result selection, destination verification, and session shutdown when another app takes the foreground. Failed runs upload Metro and Android logs.

To run it locally, start a disposable API 36 emulator, stop any Metro server on port 8081, and put `adb` on your path. Use the emulator's ABI in the Gradle command.

```sh
(cd android && ./gradlew :app:assembleDebug :fixture:assembleDebug -PintegrationFixture -PreactNativeArchitectures=arm64-v8a)
bash integration/run.sh
```

The live [Maps workflow](integration/mapsWorkflow.ts) is a separate smoke example. Start Metro with `ANDROID_AGENT_INTEGRATION=1 npm start` and launch the debug app. On an English-language emulator with Maps installed and online, enable **Android Agent window verification** in Accessibility settings. Leave Maps on its Explore screen, return to the test harness, and tap **Run Maps workflow**. The workflow checks that the Directions screen shows Warsaw Central as the destination. Maps may ask for a starting point depending on location settings.

## License

[MIT](LICENSE)
