#!/usr/bin/env bash
#
# Regenerates the desktop app icons for every platform from the same brand
# mark the extension uses. NOT part of `compile` — it wants rsvg-convert,
# magick and iconutil, and only needs re-running when the mark changes.
#
#   ./scripts/make-app-icon.sh
#
# Outputs:
#   assets/icon.png     1024×1024  master PNG (kept around for Linux & misc)
#   assets/icon.icns    macOS multi-resolution .icns bundle
#   assets/icon.ico     Windows multi-resolution .ico bundle
#   assets/trayColor{,_@2x}.png  full-color Windows/Linux tray raster
#                                       (18pt + retina @2x). macOS does NOT use
#                                       these — it uses trayTemplate.png from
#                                       make-tray-icons.sh, tinted at runtime.
#
# The artwork is INSET to ~82% of the canvas on purpose: macOS draws its own
# rounded mask and drop shadow around an app icon, so art that fills the square
# edge to edge reads as oversized next to every other icon in the Dock. Windows
# doesn't add a mask, but the same 82% inset keeps the icon proportional with
# the rounded-square favicon & taskbar look.
set -euo pipefail

cd "$(dirname "$0")/.."
SRC="../copilot/icon.svg"
INSET=840
SIZES=(16 32 128 256 512)

for tool in rsvg-convert magick iconutil; do
  command -v "$tool" >/dev/null || { echo "missing: $tool" >&2; exit 1; }
done

mkdir -p assets
rsvg-convert -w 1024 -h 1024 "$SRC" -o /tmp/wbaw-icon-raw.png
magick /tmp/wbaw-icon-raw.png \
  -resize "${INSET}x${INSET}" -background none -gravity center -extent 1024x1024 \
  assets/icon.png

# ── macOS ─────────────────────────────────────────────────────────────
rm -rf /tmp/wbaw.iconset
mkdir -p /tmp/wbaw.iconset
for size in "${SIZES[@]}"; do
  magick assets/icon.png -resize "${size}x${size}" "/tmp/wbaw.iconset/icon_${size}x${size}.png"
  magick assets/icon.png -resize "$((size * 2))x$((size * 2))" "/tmp/wbaw.iconset/icon_${size}x${size}@2x.png"
done
iconutil -c icns /tmp/wbaw.iconset -o assets/icon.icns

# ── Windows ───────────────────────────────────────────────────────────
# Windows picks the closest resolution out of the .ico bundle. Cover the
# sizes a user might actually see: taskbar (16/24/32), Explorer medium/large
# (48/64), and the high-DPI Start Menu tiles (256).
rm -f assets/icon.ico
ICO_SIZES=(16 24 32 48 64 128 256)
TMP_ICO=$(mktemp -d)
for size in "${ICO_SIZES[@]}"; do
  magick assets/icon.png -resize "${size}x${size}" -strip \
    -define png:compression-level=9 \
    "$TMP_ICO/${size}.png"
done
magick "$TMP_ICO"/*.png assets/icon.ico
rm -rf "$TMP_ICO"

# ── Windows / Linux tray ─────────────────────────────────────────────
# The colored tray raster: same full brand tile as the .icns / .ico above.
# macOS does NOT load this — it uses trayTemplate.png (rebuilt by
# make-tray-icons.sh) with the system tint applied at runtime. Windows
# and Linux render this raster as-is.
rsvg-convert -w 18 -h 18 "$SRC" -o assets/trayColor.png
rsvg-convert -w 36 -h 36 "$SRC" -o assets/trayColor@2x.png

echo "wrote assets/icon.png (1024) + assets/icon.icns + assets/icon.ico"
echo "wrote assets/trayColor.png (@2x) — Windows / Linux tray"
echo "(macOS tray template is NOT touched by this script; run"
echo " make-tray-icons.sh for that when the bare mark path changes)"
