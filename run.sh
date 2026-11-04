#!/bin/sh
# Runs TVCouchBrowser from this folder. Add --windowed for a window, or a URL to open.
set -eu
cd "$(dirname "$0")"
tools/fetch-electron.sh
case "$(uname -s)" in
  Darwin) exec .electron/Electron.app/Contents/MacOS/Electron . "$@" ;;
  *) exec .electron/electron . "$@" ;;
esac
