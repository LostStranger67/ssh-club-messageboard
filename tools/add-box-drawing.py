#!/usr/bin/env python3
"""
Add box-drawing glyphs to the bundled OCR-A font.

Why this exists
---------------
The site's ASCII banner is made of box-drawing characters (U+2550, U+2551,
U+2554, U+2557, U+255A, U+255D, U+2588). OCR-A has no glyphs for them, so the
browser fell back to DejaVu Sans Mono per character. That font's advance is
0.6021em while OCR-A's is 0.7150em, so every line of the banner became a mix
of two cell widths and the art sheared apart (~166px of drift over 92 columns).

Drawing the glyphs into OCR-A at its own 715/1000em advance keeps the banner
on a single grid.

Geometry
--------
Cell: 715 units wide (OCR-A's fixed advance), 1000 units em.
Strokes are drawn on the cell edges so that adjacent cells join seamlessly:
the stroke is centred on the cell boundary, so each neighbour contributes
half. This is how terminal box-drawing fonts behave.

    U+2588 FULL BLOCK      filled cell
    U+2550 DOUBLE HORIZ.   two parallel horizontal rules
    U+2551 DOUBLE VERT.    two parallel vertical rules
    U+2554 DOWN-RIGHT      double top + double left
    U+2557 DOWN-LEFT       double top + double right
    U+255A UP-RIGHT        double bottom + double left
    U+255D UP-LEFT         double bottom + double right

Usage: python3 tools/add-box-drawing.py [--check]
"""

import sys
import os

from fontTools.ttLib import TTFont, newTable
from fontTools.pens.ttGlyphPen import TTGlyphPen

FONT_PATH = os.path.join(
    os.path.dirname(os.path.abspath(__file__)),
    "..", "public", "fonts", "ocr-a-regular.woff2"
)

CELL_W = 715          # OCR-A's fixed advance width, in font units
EM = 1000

# Stroke thickness. OCR-A's own stems are ~95 units (see the '|' glyph, 295-390).
# Box rules use the same weight so the banner matches the surrounding text.
STROKE = 95
# Gap between the two rules of a "double" line.
DOUBLE_GAP = 60

# --- Shared rule geometry -------------------------------------------------
# Every double-line glyph must place its rules at the SAME coordinates, or a
# corner will not line up with the straight runs beside it. These are the
# single definitions both the straight glyphs and the corners use.
#
# Horizontal rules are centred vertically in the cell:
#     upper:  y = 530..625      lower:  y = 375..470
# Vertical rules are centred horizontally in the cell:
#     right:  x = 387..482      left:   x = 232..327
_H_MID = EM // 2
H_RULE_UPPER = (_H_MID + DOUBLE_GAP // 2, _H_MID + DOUBLE_GAP // 2 + STROKE)
H_RULE_LOWER = (_H_MID - DOUBLE_GAP // 2 - STROKE, _H_MID - DOUBLE_GAP // 2)

_V_MID = CELL_W // 2
V_RULE_RIGHT = (_V_MID + DOUBLE_GAP // 2, _V_MID + DOUBLE_GAP // 2 + STROKE)
V_RULE_LEFT = (_V_MID - DOUBLE_GAP // 2 - STROKE, _V_MID - DOUBLE_GAP // 2)

# A corner's arms stop at the cell centre, so `╔═` joins into one continuous
# line. (The straight glyphs span their full cell, so the corner's arm ends
# exactly where the neighbour's rule begins.)
HALF_W = CELL_W // 2
HALF_H = EM // 2


def rect(pen, x0, y0, x1, y1):
    """Append an axis-aligned filled rectangle, wound clockwise."""
    pen.moveTo((x0, y0))
    pen.lineTo((x0, y1))
    pen.lineTo((x1, y1))
    pen.lineTo((x1, y0))
    pen.closePath()


def polygon(pen, points):
    """Append a filled polygon from a list of (x, y) points."""
    pen.moveTo(points[0])
    for p in points[1:]:
        pen.lineTo(p)
    pen.closePath()


def glyph_full_block():
    pen = TTGlyphPen(None)
    rect(pen, 0, 0, CELL_W, EM)
    return pen.glyph()


def glyph_double_horizontal():
    """U+2550: two horizontal rules spanning the full width, vertically centred."""
    pen = TTGlyphPen(None)
    rect(pen, 0, H_RULE_UPPER[0], CELL_W, H_RULE_UPPER[1])
    rect(pen, 0, H_RULE_LOWER[0], CELL_W, H_RULE_LOWER[1])
    return pen.glyph()


def glyph_double_vertical():
    """U+2551: two vertical rules spanning the full height, horizontally centred."""
    pen = TTGlyphPen(None)
    rect(pen, V_RULE_RIGHT[0], 0, V_RULE_RIGHT[1], EM)
    rect(pen, V_RULE_LEFT[0], 0, V_RULE_LEFT[1], EM)
    return pen.glyph()


def _double_corner(left, top):
    """
    A double-line corner: two concentric L-shaped polygons.

    `left`/`top` select which corner of the cell the elbow sits in:
        left=True  -> vertical arms hug the left edge
        top=True   -> horizontal arms hug the top edge

    A double corner is two L's, not four crossing bars. Drawn as rectangles
    the arms always cross into a plus sign, so each L is emitted as a single
    six-point polygon that turns the corner -- the same construction real
    terminal fonts use (verified against DejaVu Sans Mono's U+2554).

    Geometry, for `╔` (top-left):

        +---------+  <- outer horizontal band, runs to the right cell edge
        |  +---+     <- inner horizontal band starts at the inner vertical
        |  |
        |  |         outer vertical band runs to the bottom cell edge
        |

    The arms reach the cell edges so they meet the neighbouring `═`/`║`.
    """
    pen = TTGlyphPen(None)

    # Outer L hugs both edges named by (left, top); inner L hugs the opposite.
    # Each L is described by the two bands it is built from.
    if top:
        h_out, h_in = H_RULE_UPPER, H_RULE_LOWER
    else:
        h_out, h_in = H_RULE_LOWER, H_RULE_UPPER
    if left:
        v_out, v_in = V_RULE_LEFT, V_RULE_RIGHT
    else:
        v_out, v_in = V_RULE_RIGHT, V_RULE_LEFT

    # The edge the outer L runs along, and the far edge it stops at.
    x_far = CELL_W if left else 0
    y_far = 0 if top else EM

    # --- Outer L: vertical arm on the outer edge, horizontal arm on the
    # outer edge, joined at the corner. Runs the full cell in both axes.
    polygon(pen, [
        (v_out[0], y_far),
        (v_out[0], h_out[1] if top else h_out[0]),
        (x_far,    h_out[1] if top else h_out[0]),
        (x_far,    h_out[0] if top else h_out[1]),
        (v_out[1], h_out[0] if top else h_out[1]),
        (v_out[1], y_far),
    ])

    # --- Inner L: same shape, offset inwards, stopping at the inner bands.
    polygon(pen, [
        (v_in[0], y_far),
        (v_in[0], h_in[1] if top else h_in[0]),
        (x_far,   h_in[1] if top else h_in[0]),
        (x_far,   h_in[0] if top else h_in[1]),
        (v_in[1], h_in[0] if top else h_in[1]),
        (v_in[1], y_far),
    ])

    return pen.glyph()


GLYPHS = {
    0x2588: ("block_full", glyph_full_block),
    0x2550: ("box_double_horizontal", glyph_double_horizontal),
    0x2551: ("box_double_vertical", glyph_double_vertical),
    0x2554: ("box_double_down_right", lambda: _double_corner(left=True, top=True)),
    0x2557: ("box_double_down_left", lambda: _double_corner(left=False, top=True)),
    0x255A: ("box_double_up_right", lambda: _double_corner(left=True, top=False)),
    0x255D: ("box_double_up_left", lambda: _double_corner(left=False, top=False)),
}


def main():
    check_only = "--check" in sys.argv

    font = TTFont(FONT_PATH)
    if "glyf" not in font:
        raise SystemExit("expected a TrueType-outline font")

    cmap = font.getBestCmap()
    already = [cp for cp in GLYPHS if cp in cmap]
    if already:
        # Rebuild rather than skip: the geometry may have changed since the
        # glyphs were first added, and this script is the source of truth.
        print(f"rebuilding: {[hex(c) for c in already]}")

    glyf = font["glyf"]
    hmtx = font["hmtx"]

    for cp, (name, builder) in GLYPHS.items():
        if name in glyf:
            del glyf[name]
        glyf[name] = builder()
        glyf[name].recalcBounds(glyf)
        hmtx[name] = (CELL_W, glyf[name].xMin)

    # Register in every Unicode cmap subtable
    for table in font["cmap"].tables:
        if table.isUnicode():
            for cp, (name, _) in GLYPHS.items():
                table.cmap[cp] = name

    # Keep glyph order tidy
    order = font.getGlyphOrder()
    for name, _ in GLYPHS.values():
        if name not in order:
            order.append(name)
    font.setGlyphOrder(order)

    if check_only:
        print("would add:", ", ".join(f"U+{cp:04X}" for cp in GLYPHS))
        return

    font.flavor = "woff2"
    font.save(FONT_PATH)
    print(f"added {len(GLYPHS)} glyphs to {FONT_PATH}")


if __name__ == "__main__":
    main()
