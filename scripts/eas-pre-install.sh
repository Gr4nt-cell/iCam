#!/usr/bin/env bash
# EAS Build: fetch the palm-shutter model (the AI zoom models are committed in the repo)
set -e
A=modules/icamera/android/src/main/assets
mkdir -p "$A"
if [ ! -s "$A/gesture_recognizer.task" ]; then
  curl -sSfL -o "$A/gesture_recognizer.task" \
    https://storage.googleapis.com/mediapipe-models/gesture_recognizer/gesture_recognizer/float16/latest/gesture_recognizer.task
fi
ls -la "$A"
