// Shared news marquee format renderer (admin preview + graffiti wall ticker).
//
// News entries are stored as plain text with optional BBCode-style tags:
//     [color=#00ccff]text[/color]   (hex must be one of the canonical palette)
//     [blink]text[/blink]
//
// render() escapes ALL HTML first, then converts only approved tags to spans,
// so the output is always safe to assign to innerHTML and nothing else can
// inject markup. Unapproved colors and stray tags are stripped (inner text kept).
(function () {
    'use strict';

    // Canonical marquee palette: red → orange → yellow → green → blue →
    // purple → pink → white (order matters: it's the swatch bar order)
    const PALETTE = [
        '#ff2200', '#ff8800', '#ffcc00', '#00ff41',
        '#00ccff', '#aa00ff', '#ff44cc', '#ffffff'
    ];
    const COLORS = new Set(PALETTE);

    function esc(str) {
        return String(str ?? '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    function render(text) {
        let out = esc(text);

        // Color tags first (whitelist only; unapproved left as literals)
        out = out.replace(/\[color=(#[0-9a-fA-F]{6})\]([\s\S]*?)\[\/color\]/g,
            (m, hex, inner) => COLORS.has(hex.toLowerCase())
                ? '<span style="color:' + hex.toLowerCase() + '">' + inner + '</span>'
                : m);

        // Blink tags (may wrap color spans from the pass above, and vice versa)
        out = out.replace(/\[blink\]([\s\S]*?)\[\/blink\]/gi,
            (m, inner) => '<span class="blink">' + inner + '</span>');

        // Drop leftover unpaired / unapproved tags so no raw markup shows
        out = out.replace(/\[(?:\/?color(?:=#[0-9a-fA-F]{6})?|\/?blink)\]/gi, '');

        return out;
    }

    window.NewsFormat = { PALETTE, render };
})();
