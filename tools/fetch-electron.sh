#!/bin/sh
# Downloads the Chromium runtime (castLabs' Electron build, which can use Widevine). The hashes are pinned,
# so a changed download is refused rather than run.
#
#   tools/fetch-electron.sh                      for this computer, into .electron/
#   tools/fetch-electron.sh darwin-arm64 <dir>   for another system, as tools/build-macos.sh uses it
set -eu
cd "$(dirname "$0")/.."
VERSION=$(sed -n 's/.*"electronVersion": "\(.*\)".*/\1/p' package.json)
TARGET=${1:-$(uname -s)-$(uname -m)}
DIR=${2:-.electron}
case "$TARGET" in
  Linux-x86_64|linux-x64)
    TARGET=linux-x64 BIN=electron
    SHA256=ee726ff1e8db21a1975b827063cb9d1f6fd024122d6ae07da4661451a00daa93 ;;
  Darwin-arm64|darwin-arm64)
    TARGET=darwin-arm64 BIN=Electron.app/Contents/MacOS/Electron
    SHA256=4eeca8c117a778b4bfaa2ab90c82b62d119b23bff172da382e14aa289c5ddf33 ;;
  *)
    echo "No runtime for $TARGET: this needs 64-bit Intel Linux or an Apple silicon Mac." >&2
    exit 1 ;;
esac
# The version alone isn't enough: this folder may have been copied from another system.
[ "$(cat "$DIR/version" 2>/dev/null)" = "$VERSION" ] && [ -e "$DIR/$BIN" ] && exit 0
TAG=$(printf 'v%s' "$VERSION" | sed 's/+/%2B/')
URL="https://github.com/castlabs/electron-releases/releases/download/$TAG/electron-$TAG-$TARGET.zip"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
echo "Downloading the runtime (about 130 MB)..."
curl -fL --progress-bar -o "$TMP/electron.zip" "$URL"
if command -v sha256sum >/dev/null; then SUM=$(sha256sum "$TMP/electron.zip"); else SUM=$(shasum -a 256 "$TMP/electron.zip"); fi
if [ "${SUM%% *}" != "$SHA256" ]; then
  echo "The download doesn't match the pinned hash, so it was not used." >&2
  exit 1
fi
rm -rf "$DIR"
mkdir "$DIR"
unzip -q "$TMP/electron.zip" -d "$DIR"
echo "Runtime ready: $(cat "$DIR/version")"
