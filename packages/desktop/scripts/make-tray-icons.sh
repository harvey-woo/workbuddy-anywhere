#!/usr/bin/env bash
#
# Regenerates the tray icon. NOT part of `compile` — it only needs re-running
# when the brand mark changes, and it wants tools (rsvg-convert) that a plain
# build should not require.
#
#   ./scripts/make-tray-icons.sh
#
# The tray is COLORED across all platforms. macOS tray icons normally go
# through `setTemplateImage(true)` so the system can tint them, but our
# brand mark is itself a full-color gradient tile — tinting it would erase
# the identity. The colored raster is what every platform shows. (The
# VS Code status bar gets its own monochrome glyph from the extension's
# codicon font; the tray is independent.)
set -euo pipefail

cd "$(dirname "$0")/.."
SRC="../copilot/icon.svg"

for tool in rsvg-convert; do
  command -v "$tool" >/dev/null || { echo "missing: $tool" >&2; exit 1; }
done

# 18pt is the macOS menu bar height; @2x is what retina actually shows.
rsvg-convert -w 18 -h 18 "$SRC" -o assets/trayTemplate.png
rsvg-convert -w 36 -h 36 "$SRC" -o assets/trayTemplate@2x.png
echo "wrote assets/trayTemplate.png (18x18) + trayTemplate@2x.png (36x36) from $SRC"
