# Bundled fonts

## ocr-a-regular.woff2

The site's single typeface.

- **Font:** OCR-AK (OCR-A + OCR-K)
- **Source:** https://github.com/retorillo/ocr-ak (`dist/OCR-AK.ttf`)
- **License:** CC0 1.0 Universal (public domain dedication) — see `LICENSE-OCR-AK.txt`
- **Changes:** converted from TTF to WOFF2; family/full/PostScript names set
  to `OCR-A`; and **7 box-drawing glyphs added** (see below). No existing
  glyph outlines were modified.

### Added glyphs

OCR-A has no box-drawing characters, but the site's ASCII banner (on the
index, rules and offline pages) is built entirely from them. Without these
the browser fell back to DejaVu Sans Mono per character, whose advance is
0.6021em against OCR-A's 0.7150em — so each banner line mixed two cell widths
and the art sheared apart (~166px of drift over 92 columns).

`tools/add-box-drawing.py` draws them into the font at OCR-A's own 715/1000em
advance, with all glyphs sharing one set of rule coordinates so a box joins up:

| Glyph | Name |
|---|---|
| `█` U+2588 | full block |
| `═` U+2550 | double horizontal |
| `║` U+2551 | double vertical |
| `╔` U+2554 | double down-right |
| `╗` U+2557 | double down-left |
| `╚` U+255A | double up-right |
| `╝` U+255D | double up-left |

Stroke weight (95 units) matches OCR-A's own stems, so the banner sits at the
same visual weight as the surrounding text.

All seven glyphs share one set of rule coordinates, which is what makes a box
join up. The rules are centred in the cell:

| Rule | Position |
|---|---|
| horizontal, upper | y = 530..625 |
| horizontal, lower | y = 375..470 |
| vertical, right | x = 387..482 |
| vertical, left | x = 232..327 |

### Corners are L-shaped polygons, not rectangles

A double corner is **two concentric L's**, each emitted as a single six-point
polygon that turns the corner. This is the one part that is easy to get wrong:
drawing a corner as rectangles — a full-width horizontal bar plus a full-height
vertical bar — always produces a **plus sign**, no matter how the rules are
paired, because each bar crosses the whole cell. All four corners then render
identically as `+`.

The construction here was matched against DejaVu Sans Mono's U+2554, which uses
the same two-polygon, six-point form. For `╔`:

| Polygon | Extent | Role |
|---|---|---|
| outer L | `x=232..715  y=0..625` | vertical arm on the left edge, horizontal arm along the top |
| inner L | `x=387..715  y=0..470` | same shape, offset inwards by the double-line gap |

The outer L's arms reach the cell edges so they meet the neighbouring `═`/`║`;
the inner L stops at the inner bands, which is what makes the line double
rather than single.

Re-run the script after replacing the font file:

```sh
python3 tools/add-box-drawing.py
```

It is monospaced (a single 715/1000 em advance), which the graffiti wall
depends on: its grid is sized in `ch` units, so every cell must be exactly
one character wide.

### Why not Fira Code

Fira Code was replaced because its `calt` table substitutes punctuation with
invisible "spacer" glyphs to build ligatures (`exclam -> exclam.spacer`,
`period -> period.spacer`). In text inputs that made `!!` or `...` look like
the characters were being deleted, even though the value was correct. OCR-A
has no `calt` table, so punctuation always renders as itself.

### Why this source

Other "free OCR-A" downloads were rejected:

- `fonts.cdnfonts.com` serves Adobe "OCR A Std" and Monotype "OCR A Extended".
  Both are commercial fonts redistributed without authorization; their
  embedded licenses prohibit web embedding and redistribution.
- `bcssupp0rt/ocrafont` claims GPL-3.0 in the repo, but the font files carry
  Barcodesoft's proprietary EULA (paid tiered licensing, web embedding capped
  at 10,000 users on one domain, no standalone redistribution). The repo's
  GPL claim conflicts with the embedded license.
- The CTAN `ocr-a` Metafont sources are permissively licensed but do not
  compile cleanly under modern Metafont (undefined coordinates, improper
  font parameters), and produce bitmap-only output with no `!` glyph.
