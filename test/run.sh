#!/bin/sh
# Unit tests, then the real app driven end to end. On Linux it uses a hidden display (nothing appears on
# screen); on a Mac there is no hidden display, so a window opens for the length of the test.
set -e
cd "$(dirname "$0")/.."
tools/fetch-electron.sh
if [ "$(uname -s)" = Darwin ]; then
  E=.electron/Electron.app/Contents/MacOS/Electron
  ELECTRON_RUN_AS_NODE=1 $E --test test/unit.test.js
  # macOS has no timeout command; this is the same 120 s limit.
  perl -e 'alarm 120; exec @ARGV' $E test/e2e.js --windowed
else
  E=.electron/electron
  ELECTRON_RUN_AS_NODE=1 $E --test test/unit.test.js
  timeout -s KILL 120 $E --ozone-platform=headless --disable-gpu test/e2e.js --windowed
fi
