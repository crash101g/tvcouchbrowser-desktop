#!/bin/sh
# Builds dist/tvcouchbrowser_<version>_amd64.deb. Needs no root.
set -eu
cd "$(dirname "$0")/.."
tools/fetch-electron.sh
VERSION=$(sed -n 's/.*"version": "\(.*\)".*/\1/p' package.json)
ROOT=$(mktemp -d)
trap 'rm -rf "$ROOT"' EXIT
OPT="$ROOT/opt/tvcouchbrowser"
mkdir -p "$ROOT/DEBIAN" "$ROOT/usr/bin" "$ROOT/usr/share/applications" "$ROOT/usr/share/icons/hicolor/256x256/apps" "$OPT/resources/app" dist
cp -a .electron/. "$OPT/"
rm -f "$OPT/resources/default_app.asar"
cp -a package.json LICENSE NOTICE src vendor assets "$OPT/resources/app/"
mv "$OPT/electron" "$OPT/tvcouchbrowser"
chmod 4755 "$OPT/chrome-sandbox" # the sandbox helper, for systems that restrict user namespaces; as Chrome does
ln -s /opt/tvcouchbrowser/tvcouchbrowser "$ROOT/usr/bin/tvcouchbrowser"
cp tools/tvcouchbrowser.desktop "$ROOT/usr/share/applications/"
cp assets/icon.png "$ROOT/usr/share/icons/hicolor/256x256/apps/tvcouchbrowser.png"
cat > "$ROOT/DEBIAN/control" <<CONTROL
Package: tvcouchbrowser
Version: $VERSION
Architecture: amd64
Maintainer: TVCouchBrowser for Linux <noreply@localhost>
Section: web
Priority: optional
Depends: libgtk-3-0t64 | libgtk-3-0, libnss3, libasound2t64 | libasound2, libgbm1, libdrm2, libxkbcommon0
Recommends: avahi-utils
Homepage: https://github.com/crash101g/tvcouchbrowser
Description: Couch browser: blocks ads, works with a remote, type from your phone
 A Linux port of TVCouchBrowser for Android TV. Built-in ad blocking, cursor and
 link navigation from a remote or keyboard, and a phone page for typing, a
 trackpad and opening links.
CONTROL
dpkg-deb --root-owner-group --build "$ROOT" "dist/tvcouchbrowser_${VERSION}_amd64.deb" >/dev/null
ls -lh dist/*.deb
