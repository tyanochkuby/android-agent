# Agent instructions

Don't introduce weirdly specific tools or logic for particular tools. If you think that's what you need to do, agree with me first

## Offline speech

The assistant transcribes offline with Parakeet TDT 0.6B v3 INT8 through sherpa-onnx 2.0.3. Gradle verifies the pinned sherpa-onnx runtime. The app downloads and verifies the pinned Parakeet archive during setup. Keep model files and runtime binaries out of git.

To check decoding without a microphone, run `android/scripts/speech-samples.sh` (macOS, Samantha and Zosia voices), then `./gradlew :app:connectedDebugAndroidTest -PreactNativeArchitectures=arm64-v8a` from `android/`. The smoke test checks that each sample produces text and logs timings and word error rate under `ParakeetSmoke`. The smoke test installs the model if it is missing, so its first run needs network access. Test inputs are 16 kHz mono 16-bit WAVs in `android/app/build/generated/speech-samples`, with optional matching `.txt` references.

The assistant logs timings and error codes under `AssistantSpeech`. Keep audio and transcripts out of app logs.
