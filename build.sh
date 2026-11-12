#!/bin/bash
# Builds Terra Nota.app from this folder and installs it in ~/Applications.
# Your saved travels live elsewhere, so this never touches them.
set -euo pipefail
cd "$(dirname "$0")"

APP_NAME="Terra Nota"
INSTALLED="$HOME/Applications/$APP_NAME.app"
BUILD="build"
BUNDLE="$BUILD/$APP_NAME.app"

mkdir -p "$BUILD"
rm -rf "$BUNDLE"
mkdir -p "$BUNDLE/Contents/MacOS" "$BUNDLE/Contents/Resources"

echo "Compiling..."
swiftc -O native/main.swift -o "$BUNDLE/Contents/MacOS/$APP_NAME" -framework Cocoa -framework WebKit

if [ ! -f "$BUILD/AppIcon.icns" ]; then
  echo "Drawing the icon..."
  swift native/make_icon.swift web/data/world.js "$BUILD/icon.png"
  ICONSET="$BUILD/AppIcon.iconset"
  rm -rf "$ICONSET"
  mkdir -p "$ICONSET"
  for size in 16 32 128 256 512; do
    sips -z "$size" "$size" "$BUILD/icon.png" --out "$ICONSET/icon_${size}x${size}.png" >/dev/null
    double=$((size * 2))
    sips -z "$double" "$double" "$BUILD/icon.png" --out "$ICONSET/icon_${size}x${size}@2x.png" >/dev/null
  done
  iconutil -c icns "$ICONSET" -o "$BUILD/AppIcon.icns"
fi

cp native/Info.plist "$BUNDLE/Contents/Info.plist"
cp "$BUILD/AppIcon.icns" "$BUNDLE/Contents/Resources/AppIcon.icns"
cp -R web "$BUNDLE/Contents/Resources/web"
codesign --force --deep --sign - "$BUNDLE"

mkdir -p "$HOME/Applications"
rm -rf "$INSTALLED"
mv "$BUNDLE" "$INSTALLED"
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f "$INSTALLED"
ln -sfn "$INSTALLED" "$APP_NAME.app"

echo "Installed: $INSTALLED"
