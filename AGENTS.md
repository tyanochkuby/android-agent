# Agent instructions

Agree with the user before adding tools or logic specific to a particular app or tool.

## Offline speech

Keep model files and runtime binaries out of Git. Gradle verifies the pinned sherpa-onnx runtime. Android Agent downloads and verifies the pinned Parakeet model during setup.

For a microphone-free smoke test, run `android/scripts/speech-samples.sh` on macOS, then run `./gradlew :app:connectedDebugAndroidTest -PreactNativeArchitectures=arm64-v8a` from `android/`. The test downloads the model if it is missing. It accepts 16 kHz mono 16-bit WAVs in `android/app/build/generated/speech-samples` with optional matching `.txt` references.

Use `ParakeetSmoke` for timing and word error rate, and `AssistantSpeech` for app timings and error codes. Keep audio and transcripts out of logs.
