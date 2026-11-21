# Android Agent

Android Agent is an Android-first assistant project. The first action sends a timer request to the device’s clock app. Pick 1, 5, or 10 minutes and tap **Start timer**. The app reports the handoff. Open Clock to verify that the countdown is running.

The timer works locally without a model, account, or subscription. See [the architecture and Android constraints](docs/architecture.md) for the planned execution runtime and integration strategy.

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

## Checks

```sh
npm run lint
npm run typecheck
npm test -- --runInBand
(cd android && ./gradlew :app:assembleDebug :app:lintDebug)
```

The Jest tests cover duration selection, bridge calls, and error recovery. On a device, select **1 min**, tap **Start timer**, and open Clock to confirm it is counting down from one minute. Repeat with **10 min** to check the default duration, then dismiss the test timers. `ACTION_SET_TIMER` asks the clock app to start the timer and skip its setup screen. Some handlers may still show UI. [Android timer intent reference](https://developer.android.com/reference/android/provider/AlarmClock#ACTION_SET_TIMER)

## License

[MIT](LICENSE)
