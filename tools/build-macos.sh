#!/bin/sh
# Builds dist/TVCouchBrowser-<version>-macos-arm64.zip, holding TVCouchBrowser.app. Runs on a Mac (with
# nothing to install) or on Linux (needs rcodesign, from github.com/indygreg/apple-platform-rs, on the PATH).
#
# Streaming sites need the app signed by castLabs' free EVS service: see "macOS" in the README. Pass
# --no-evs to build without it, for trying everything except protected video.
set -eu
cd "$(dirname "$0")/.."
EVS=1
[ "${1:-}" = --no-evs ] && EVS=0

if command -v codesign >/dev/null; then SIGN=codesign
elif command -v rcodesign >/dev/null; then SIGN=rcodesign
else echo "Needs codesign (on a Mac) or rcodesign (on Linux) to sign the app." >&2; exit 1
fi
if [ "$EVS" = 1 ] && ! python3 -c 'import castlabs_evs' 2>/dev/null; then
  echo "Needs castLabs' EVS client for streaming sites: pip3 install --user castlabs-evs" >&2
  echo "Then sign up once: python3 -m castlabs_evs.account signup" >&2
  echo "To build without it, pass --no-evs: protected video won't play." >&2
  exit 1
fi

tools/fetch-electron.sh darwin-arm64 .electron-macos
VERSION=$(sed -n 's/.*"version": "\(.*\)".*/\1/p' package.json)
NAME=TVCouchBrowser
ID=local.tvcouchbrowser
OUT="$PWD/dist/$NAME-$VERSION-macos-arm64.zip"
ROOT=$(mktemp -d)
trap 'rm -rf "$ROOT"' EXIT
APP="$ROOT/$NAME.app"
mkdir -p dist
cp -a .electron-macos/Electron.app "$APP"
RES="$APP/Contents/Resources"

mkdir "$RES/app"
cp -a package.json LICENSE NOTICE src vendor assets "$RES/app/"
rm -f "$RES/default_app.asar" "$RES/electron.icns"
cp assets/icon.icns "$RES/$NAME.icns"

# The main program and its helpers must all carry the app's name, or the app can't find its helpers.
mv "$APP/Contents/MacOS/Electron" "$APP/Contents/MacOS/$NAME"
for suffix in '' ' (GPU)' ' (Plugin)' ' (Renderer)'; do
  helper="$APP/Contents/Frameworks/Electron Helper$suffix.app"
  mv "$helper/Contents/MacOS/Electron Helper$suffix" "$helper/Contents/MacOS/$NAME Helper$suffix"
  mv "$helper" "$APP/Contents/Frameworks/$NAME Helper$suffix.app"
done

# The integrity entry describes default_app.asar, which is gone. The Local Network text is what macOS
# shows when it asks permission for the phone page.
for plist in "$APP/Contents/Info.plist" "$APP/Contents/Frameworks/$NAME Helper"*.app/Contents/Info.plist; do
  sed -i.bak \
    -e "s/<string>Electron/<string>$NAME/" \
    -e "s/com\.github\.Electron/$ID/" \
    -e "s/<string>electron\.icns</<string>$NAME.icns</" \
    -e 's/public\.app-category\.developer-tools/public.app-category.entertainment/' \
    -e '/<key>ElectronAsarIntegrity<\/key>/,/^	<\/dict>/d' \
    -e 's|<key>NSHighResolutionCapable</key>|<key>NSLocalNetworkUsageDescription</key><string>Lets your phone act as the remote, trackpad and keyboard.</string><key>NSBonjourServices</key><array><string>_http._tcp</string></array>&|' \
    -e "/<key>CFBundleShortVersionString<\/key>/{n;s/<string>.*</<string>$VERSION</;}" \
    -e "/<key>CFBundleVersion<\/key>/{n;s/<string>.*</<string>$VERSION</;}" \
    "$plist"
  rm "$plist.bak"
done

# In this order: VMP signing covers the program, and code signing then has to cover the VMP signature.
if [ "$EVS" = 1 ]; then
  python3 -m castlabs_evs.vmp sign-pkg "$ROOT" || {
    echo "EVS signing failed. If your login expired, run: python3 -m castlabs_evs.account reauth" >&2
    exit 1
  }
fi
# An ad-hoc signature: enough to run on Apple silicon, but it doesn't identify a developer to Gatekeeper.
if [ "$SIGN" = codesign ]; then codesign --force --deep --sign - "$APP"
else rcodesign sign "$APP" >/dev/null 2>&1
fi

rm -f "$OUT"
(cd "$ROOT" && zip -qry "$OUT" "$NAME.app") # -y keeps the framework's symlinks
ls -lh "$OUT"
[ "$EVS" = 1 ] || echo "Built without EVS: protected video won't play on streaming sites."
