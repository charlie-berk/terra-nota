#!/bin/bash
# Makes "Terra Nota.zip" on your Desktop, ready to send to a friend.
# The app inside runs on both Apple Silicon and Intel Macs (macOS 12 or later).
# It holds no travels: yours stay in ~/Library/Application Support/Terra Nota,
# and the installed app in ~/Applications isn't touched.
set -euo pipefail
cd "$(dirname "$0")"

APP_NAME="Terra Nota"
OUT="${1:-$HOME/Desktop/$APP_NAME.zip}"
STAGE="build/share"
FOLDER="$STAGE/$APP_NAME"
BUNDLE="$FOLDER/$APP_NAME.app"

if [ -e "$OUT" ]; then
  echo "$OUT already exists. Move it aside first, or pass another path." >&2
  exit 1
fi

rm -rf "$STAGE"
mkdir -p "$BUNDLE/Contents/MacOS" "$BUNDLE/Contents/Resources"

echo "Compiling for Apple Silicon and Intel..."
for arch in arm64 x86_64; do
  swiftc -O -target "$arch-apple-macos12" native/main.swift -o "$STAGE/main-$arch" -framework Cocoa -framework WebKit
done
lipo -create "$STAGE/main-arm64" "$STAGE/main-x86_64" -output "$BUNDLE/Contents/MacOS/$APP_NAME"

if [ ! -f build/AppIcon.icns ]; then
  echo "Run ./build.sh once first, to draw the icon." >&2
  exit 1
fi
cp native/Info.plist "$BUNDLE/Contents/Info.plist"
cp build/AppIcon.icns "$BUNDLE/Contents/Resources/AppIcon.icns"
cp -R web "$BUNDLE/Contents/Resources/web"
codesign --force --deep --sign - "$BUNDLE"

cat > "$FOLDER/Read me first.txt" <<'EOF'
TERRA NOTA
A private map of everywhere you've been and lived. It runs entirely on your
Mac and never goes online. Needs macOS 12 or later, on any Mac.

INSTALLING
  1. Drag Terra Nota.app into your Applications folder.
  2. Open it. macOS will say it can't check the app, because it isn't from
     the App Store or a registered developer. To open it anyway:
       macOS 14 or earlier: right-click the app, choose Open, then Open.
       macOS 15 or later:   try to open it once and close the warning, then
                            go to System Settings > Privacy & Security,
                            scroll down, and click Open Anyway.
     You only need to do this once.

USING IT
  Click a country to open it and tick off its states. Drag or scroll to move
  the map (it wraps all the way around), pinch to zoom. Your marks are saved
  in ~/Library/Application Support/Terra Nota, with daily backups.
EOF

mkdir -p "$(dirname "$OUT")"
ditto -c -k --keepParent "$FOLDER" "$OUT"
rm -f "$STAGE/main-arm64" "$STAGE/main-x86_64"
echo "Made: $OUT ($(du -h "$OUT" | cut -f1 | tr -d ' '))"
