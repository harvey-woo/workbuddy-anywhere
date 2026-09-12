#!/usr/bin/env python3
"""
Build a custom icon font (WOFF) for the CodeBuddy status-bar icon.

VS Code 1.136 renders `$(custom-icon)` in status bar text (proven by
alibaba-cloud.tongyi-lingma). We build a WOFF whose private-use glyph
(U+E001) contains the CodeBuddy mark, then declare it via
`contributes.icons` in package.json.

This script is deliberately conservative:
  * Reads the SINGLE even-odd <path> from `media/icon-mono-path.svg`
    (the entire visible mark is a single <path> with fill-rule="evenodd",
    so we can convert the whole `d` to one glyph outline).
  * Converts cubic Beziers to quadratic (glyf table needs quadratics).
  * Centers the glyph inside the em square and VERIFIES it has non-zero
    ink before writing the WOFF (a previous version shipped an empty
    glyph, which made `$(codebuddy)` render blank in the status bar).
  * Emits WOFF + TTF into `media/`.

Run:  python3 scripts/build-codicon-font.py
"""

import os
import re
import sys

from fontTools.fontBuilder import FontBuilder
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.ttGlyphPen import TTGlyphPen
from fontTools.svgLib.path import parse_path
from fontTools.ttLib import TTFont
from fontTools.misc.transform import Transform
from fontTools.pens.transformPen import TransformPen
from fontTools.pens.cu2quPen import Cu2QuPen

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
ICON_SRC = os.path.join(ROOT, "media", "icon-mono-path.svg")
OUT_DIR = os.path.join(ROOT, "media")
CODEPOINT = 0xE001  # private use area
UPEM = 1000


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    if not os.path.exists(ICON_SRC):
        print(f"missing {ICON_SRC}")
        sys.exit(1)

    svg = open(ICON_SRC, encoding="utf-8").read()
    # Single <path d="..."> with even-odd fill = the whole CodeBuddy mark.
    path_ds = re.findall(r'<path\s+d="([^"]+)"', svg)
    if not path_ds:
        print("no <path> in", ICON_SRC)
        sys.exit(1)
    d = max(path_ds, key=len)

    # Path extent in user units (viewBox 0 0 32 32, but the d can go a bit
    # outside; clamp and fit).
    nums = [float(x) for x in re.findall(r"[-+]?\d*\.?\d+", d)]
    xs, ys = nums[0::2], nums[1::2]
    x0, x1 = min(xs), max(xs)
    y0, y1 = min(ys), max(ys)
    w, h = x1 - x0, y1 - y0
    print(f"path bbox: x[{x0},{x1}] y[{y0},{y1}] w={w:.1f} h={h:.1f}")

    # Fit glyph in the cap-height area of the em square, centered.
    # Font y is up; SVG y is down. We flip and translate so cat top-up fits.
    cap = 0.85  # use 85% of em for the glyph
    scale = (UPEM * cap) / max(w, h)
    advance = int(UPEM * 0.8)  # compact advance so the icon sits tight
    # center horizontally: shift so (x0..x1)*scale lands inside [pad, advance-pad]
    pad = int((advance - w * scale) / 2)
    # y mapping: svg (y0..y1) -> font (bottom..top near cap). Flip y.
    y_translate = UPEM * 0.92  # near top of em (just below ascender)
    transform = Transform(scale, 0, 0, -scale, pad, y_translate)
    print(f"transform scale={scale:.2f} pad={pad} y_translate={y_translate}")

    # Build the glyph: SVG path -> cubic -> quadratic -> TTGlyphPen
    glyph_pen = TTGlyphPen(None)
    qpen = Cu2QuPen(glyph_pen, max_err=1.0, reverse_direction=True)
    tpen = TransformPen(qpen, transform)
    parse_path(d, tpen)
    glyph = glyph_pen.glyph()

    # VERIFY the glyph has visible ink (this was the root cause of the
    # earlier "icon is empty" — an outline with no filled area).
    glyph.recalcBounds({})  # compute bounds using the same table
    if glyph.numberOfContours <= 0 or (glyph.xMax - glyph.xMin) <= 0 or (glyph.yMax - glyph.yMin) <= 0:
        print("ERROR: generated glyph has no ink (empty bounds):", glyph.numberOfContours, glyph.xMin, glyph.yMin, glyph.xMax, glyph.yMax)
        sys.exit(2)
    print(f"glyph OK: contours={glyph.numberOfContours} bounds=({glyph.xMin},{glyph.yMin})-({glyph.xMax},{glyph.yMax})")

    glyph_order = [".notdef", "space", "codebuddy"]
    fb = FontBuilder(UPEM, isTTF=True)
    glyf = {}

    # .notdef: empty box so unknown glyphs render as a placeholder
    p = TTGlyphPen(None)
    p.moveTo((50, 0)); p.lineTo((50, UPEM)); p.lineTo((UPEM - 50, UPEM)); p.lineTo((UPEM - 50, 0)); p.closePath()
    glyf[".notdef"] = p.glyph()
    p = TTGlyphPen(None)
    glyf["space"] = p.glyph()
    glyf["codebuddy"] = glyph

    for g in glyf.values():
        g.recalcBounds(glyf)

    fb.setupGlyphOrder(glyph_order)
    fb.setupCharacterMap({0: ".notdef", 0x20: "space", CODEPOINT: "codebuddy"})
    fb.setupGlyf(glyf)
    fb.setupHorizontalMetrics({
        ".notdef": (UPEM, 0),
        "space": (int(UPEM * 0.3), 0),
        "codebuddy": (advance, 0),
    })
    fb.setupHorizontalHeader(ascent=UPEM, descent=0)
    fb.setupNameTable({
        "familyName": "CodeBuddy Icons",
        "styleName": "Regular",
        "uniqueFontIdentifier": "CodeBuddy Icons",
        "version": "1.0",
        "psName": "CodeBuddyIcons-Regular",
    })
    fb.setupOS2(sTypoAscender=UPEM, sTypoDescender=0, usWinAscent=UPEM, usWinDescent=0)
    fb.setupPost()

    ttf_path = os.path.join(OUT_DIR, "codebuddy-icon.ttf")
    fb.save(ttf_path)
    font = TTFont(ttf_path)
    woff_path = os.path.join(OUT_DIR, "codebuddy-icon.woff")
    font.flavor = "woff"
    font.save(woff_path)

    # Final verification on the saved font
    f2 = TTFont(woff_path)
    name = f2.getBestCmap()[CODEPOINT]
    g = f2["glyf"][name]
    g.recalcBounds(f2["glyf"])
    print(f"saved WOFF glyph '{name}' at U+{CODEPOINT:04X}: "
          f"contours={g.numberOfContours} bbox=({g.xMin},{g.yMin})-({g.xMax},{g.yMax})")
    if g.numberOfContours <= 0 or (g.xMax - g.xMin) <= 0 or (g.yMax - g.yMin) <= 0:
        print("ERROR: WOFF glyph is empty!")
        sys.exit(3)
    print("OK — glyph has ink, ready to ship.")
    print(f"  {ttf_path}")
    print(f"  {woff_path}")


if __name__ == "__main__":
    main()
