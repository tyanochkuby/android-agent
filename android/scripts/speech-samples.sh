#!/bin/sh
# Writes synthetic speech samples for ParakeetSmokeTest into app/build/generated/speech-samples. Needs macOS `say` with the Samantha and Zosia voices.
# Each sample is <language>-<name>.wav (16 kHz mono 16-bit PCM) with the spoken text in <language>-<name>.txt.
# Add your own recordings in the same format to that directory to run them through the test.
set -eu
out="$(dirname "$0")/../app/build/generated/speech-samples"
mkdir -p "$out"

sample() {
  printf '%s' "$3" > "$out/$1.txt"
  say -v "$2" -o "$out/$1.wav" --data-format=LEI16@16000 "$3"
}

sample en-timer Samantha "Set a timer for five minutes and then open Google Maps."
sample en-message Samantha "Send a message to Anna saying I will be twenty minutes late."
sample pl-timer Zosia "Ustaw minutnik na pięć minut, a potem otwórz Mapy Google."
sample pl-call Zosia "Zadzwoń do Krzysztofa Wiśniewskiego jutro o siedemnastej trzydzieści."
sample pl-mixed Zosia "Otwórz Spotify i włącz playlistę Chill Vibes."
ls "$out"
