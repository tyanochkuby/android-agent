# Android Agent

Android Agent is an Android-first assistant project. The app is a chat with an agent that runs Android tools on the phone and uses your ChatGPT plan after you sign in with ChatGPT on the phone. On API 36 it can also be the default digital assistant and answer spoken prompts over other apps.

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

Tap **Sign in with ChatGPT**, sign in in the browser and allow ChatGPT plan usage, then return to Android Agent. The app uses OpenAI's [Sign in with ChatGPT](https://developers.openai.com/siwc/token-sharing-open-source/sign-in) flow and streams replies from the public [Responses API](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference) on the first model in the account's eligible catalog. The credentials stay on the phone, encrypted with an Android Keystore key. **Sign out of ChatGPT** removes them and revokes the sign-in. Later sign-ins must use the same ChatGPT account.

### Companion

The app can also send prompts through a Node.js companion on your computer, connected over USB. The companion signs in with OpenAI's open-source [Sign in with ChatGPT DevKit](https://developers.openai.com/siwc/token-sharing-open-source) and streams replies from the public [Responses API](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference) on your ChatGPT plan. It uses the first model in the account's eligible catalog. The phone receives model replies and runs the tools itself. On macOS the companion saves the ChatGPT session locally, encrypted with a key in Keychain. Other platforms keep sign-in in memory for the lifetime of the companion.

Build the DevKit in a separate checkout. It has its own [license](https://github.com/openai/sign-in-with-chatgpt-devkit/blob/main/LICENSE). The patch from this repository adds one method, `openResponsesSocket`, which opens an authenticated Responses WebSocket while the DevKit keeps refreshing and storing the credentials. The companion reuses that socket so the provider can serve the conversation prefix from cache and report token usage. Without the patch the companion falls back to HTTP, reports no usage and never compacts idle conversations.

```sh
git clone https://github.com/openai/sign-in-with-chatgpt-devkit.git
cd sign-in-with-chatgpt-devkit
git checkout 0a36fefeb913055c8c7a1a29b63d82b96b2e841a
git apply /path/to/android-agent/companion/devkit-responses-socket.patch
npm ci --ignore-scripts
npm run build -w @siwc/local
```

From the Android Agent checkout, start the companion and forward its port to the device.

```sh
node companion/server.mjs /path/to/sign-in-with-chatgpt-devkit
adb reverse tcp:8765 tcp:8765
```

Add `--sign-in` after the DevKit path to open the ChatGPT sign-in page at startup if there is no saved session with plan usage enabled.

In Android Agent, enter the pairing code the companion printed and tap **Check connection**. If sign-in is needed, tap **Sign in on companion**, approve plan usage in the browser, then check the connection again. After a companion restart on macOS, enter the new pairing code and check the connection to use the saved session.

### Try it

1. Try `Set a timer for 2 minutes and 17 seconds` and check the countdown in Clock. The app can only confirm that it sent the intent.
2. For Maps, enable **Android Agent window verification** in **Accessibility settings** first. Back in Android Agent, enter `In Google Maps, open directions to Warsaw Central Station and stop at the route preview` after turning on **Share screen with the agent**. Keep Maps in the foreground while the agent works, then return to Android Agent for its reply. The UI session expires after one minute.

Each model reply is an ordered list of tool calls, and the results go back to the model for the next step. A prompt gets at most one timer dispatch, because a failed call can leave the dispatch outcome unknown, and one foreground UI session. Clock works without screen sharing.

Screen sharing is a persistent setting, off by default. **Share screen with the agent** in the connection panel turns it on for every later typed and spoken prompt, with no further question per prompt, until you turn it off. While it is on, the agent can open installed apps, send their visible labels and controls to the connected model, and click or type into a control that matches uniquely on the current screen. Visible labels can contain personal information. Only the latest observation of each app stays in the model context. With the setting off, the screen tools stay advertised and return a setup error.

On Android 14 and later, `get_screen` also takes a screenshot of the app the agent is working in, but only when the model asks for one during a prompt. Screenshots of secure windows are refused. Taken screenshots stay in app-private storage for later prompts, up to 24, scoped to the signed-in account; `list_screenshots` and `read_screenshot` reach them by ID. Turning the setting off or signing out deletes them. Direct ChatGPT sign-in sends the image to the model. The companion connection is text-only and gets the visible text instead.

On Android 16, the voice assistant can also use the screen. With screen sharing on, a request spoken over another app can read that app and continue in up to three other apps, for example to add tracks from a video description to a playlist. With it off, voice requests stay text-only.

## Checks

```sh
npm run lint
npm run typecheck
npm test -- --runInBand
(cd android && ./gradlew :app:testDebugUnitTest :app:assembleDebug :app:lintDebug)
```

To build a debug APK that runs without Metro, add `-PbundleJs`. It is signed with the local debug key.

```sh
(cd android && ./gradlew :app:assembleDebug -PbundleJs -PreactNativeArchitectures=arm64-v8a)
```

## Device smoke test

Use a sideloaded debug build on a stock Pixel 9 with Clock and Google Maps installed and Android Agent signed in with ChatGPT. An API 36 Google APIs emulator with those apps can exercise the same flow.

1. Send `Set a timer for 1 minute`. Open Clock to confirm the countdown and dismiss the test timer. In Android Agent, the saved step reads `issued`. [Android timer intent reference](https://developer.android.com/reference/android/provider/AlarmClock#ACTION_SET_TIMER)
2. Tap the Accessibility settings note under the composer, enable **Android Agent window verification**, and return to Android Agent. Android may require allowing restricted settings for the sideloaded app before it can enable the service.
3. Turn on **Share screen with the agent** and send `Open Google Maps`. Once Maps is visible, give the observation a moment to complete, then return to Android Agent. The open step should report **Google Maps window verified**.
4. Force-stop and reopen Android Agent. The latest task should still be visible. A recorded `issued` or verified action should retain that status without another launch.
5. Choose Android Agent as the default digital assistant, open another app and invoke the assistant. Ask a short question. The blue working dot should turn into a reply card without bringing Android Agent forward, and the turn should appear in Android Agent's history.

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
