// Wall Export: composites all three canvas layers (grid + static + blink)
// from backend data into a 2-frame animated GIF (1 fps) and triggers download.
//
// The blink cycle on the wall is 1s per color (BLINK_PHASE_MS=1000), so a
// 2-frame GIF with 1000ms delay per frame replays the blink at the same
// speed as the live wall.

(function () {
    'use strict';

    // Same palette indices as the graffiti wall (DB stores indices into this)
    const PALETTE = [
        '#00ff41', // 0 Green
        '#ff44cc', // 1 Pink
        '#00ccff', // 2 Cyan
        '#ffcc00', // 3 Yellow
        '#ff8800', // 4 Orange
        '#aa00ff', // 5 Purple
        '#ffffff', // 6 White
        '#ff2200', // 7 Red
    ];

    const BLINK_BASE = 800;
    const LEGACY_BLINK = 8;

    // Grid dimensions (must match server + graffiti.js)
    const COLS = 300;
    const ROWS = 150;

    // Export rendering parameters — match the live wall exactly:
    // #wall-container uses font-size:15px, line-height:1em, width:300ch.
    // Cell height = 1em (15px). Cell width = 1ch (measured below, ~9px for
    // Fira Code). This keeps the aspect ratio identical to the wall.
    const FONT_SIZE = 15;
    const FONT = 'Fira Code, Courier New, monospace';
    const CELL_H = FONT_SIZE; // 1em = font-size
    // Measure 1ch at the target font size using a throwaway canvas
    const _m = document.createElement('canvas').getContext('2d');
    _m.font = FONT_SIZE + 'px ' + FONT;
    const CELL_W = _m.measureText('0').width; // ch width (≈9px for Fira Code)
    const W = Math.round(COLS * CELL_W);  // ≈2700
    const H = Math.round(ROWS * CELL_H);  // 2250

    // Glow parameters: same as the live wall at 1× dpr
    // (static = 2, blink = 3 + 10)
    const STATIC_GLOW = 2;
    const BLINK_GLOW_1 = 3;
    const BLINK_GLOW_2 = 10;

    function isBlinkValue(v) {
        return v === LEGACY_BLINK || v >= BLINK_BASE;
    }

    // Render one frame of the full wall (all layers composited)
    function renderFrame(pixels, phase) {
        const canvas = document.createElement('canvas');
        canvas.width = W;
        canvas.height = H;
        const ctx = canvas.getContext('2d');

        // Background
        ctx.fillStyle = '#000000';
        ctx.fillRect(0, 0, W, H);

        // Grid layer: 7% opacity accent (same as live wall)
        ctx.globalAlpha = 0.07;
        ctx.strokeStyle = '#00cc00';
        ctx.lineWidth = 1;
        for (let x = 0; x <= COLS; x++) {
            const px = Math.round(x * CELL_W);
            ctx.beginPath();
            ctx.moveTo(px + 0.5, 0);
            ctx.lineTo(px + 0.5, H);
            ctx.stroke();
        }
        for (let y = 0; y <= ROWS; y++) {
            const py = Math.round(y * CELL_H);
            ctx.beginPath();
            ctx.moveTo(0, py + 0.5);
            ctx.lineTo(W, py + 0.5);
            ctx.stroke();
        }
        ctx.globalAlpha = 1;

        // Glyph layers: draw each pixel at its cell center
        ctx.font = FONT_SIZE + 'px ' + FONT;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';

        for (const [x, y, ch, brightness, color] of pixels) {
            if (!ch || ch === ' ') continue;

            let colorIdx, glow;
            if (isBlinkValue(color)) {
                const v = color === LEGACY_BLINK ? BLINK_BASE + 7 * 10 + 2 : color;
                // Phase 0 = first color (a), Phase 1 = second color (b)
                colorIdx = phase === 0
                    ? Math.floor((v - BLINK_BASE) / 10)
                    : (v - BLINK_BASE) % 10;
                glow = 'blink';
            } else {
                colorIdx = color;
                glow = 'static';
            }

            const hex = PALETTE[colorIdx] || PALETTE[0];
            // Center within the rectangular cell (same math as the live
            // wall: floor edges → midpoint, rounded to integer)
            const left = Math.floor(x * W / COLS);
            const right = Math.floor((x + 1) * W / COLS);
            const top = Math.floor(y * H / ROWS);
            const bottom = Math.floor((y + 1) * H / ROWS);
            const cx = Math.round(left + (right - left) / 2);
            const cy = Math.round(top + (bottom - top) / 2);

            ctx.globalAlpha = Math.max(0, Math.min(1, brightness));
            ctx.fillStyle = hex;
            ctx.shadowColor = hex;

            if (glow === 'blink') {
                // Two-pass glow matching the live wall's 3px + 10px text-shadow
                ctx.shadowBlur = BLINK_GLOW_1;
                ctx.fillText(ch, cx, cy);
                ctx.shadowBlur = BLINK_GLOW_2;
                ctx.fillText(ch, cx, cy);
            } else {
                ctx.shadowBlur = STATIC_GLOW;
                ctx.fillText(ch, cx, cy);
            }
        }
        ctx.globalAlpha = 1;
        ctx.shadowBlur = 0;

        return canvas;
    }

    // Main export: fetch data, render 2 frames, encode GIF, download
    async function exportWallGif() {
        const btn = document.getElementById('export-wall-btn');
        const status = document.getElementById('export-wall-status');

        try {
            btn.disabled = true;
            status.textContent = '> Fetching wall data...';

            // 1. Fetch all pixels from the backend
            const res = await fetch('/api/graffiti');
            if (!res.ok) throw new Error('HTTP ' + res.status);
            const pixels = await res.json(); // [[x, y, char, brightness, color], ...]

            status.textContent = `> Rendering ${pixels.length} pixels (2 frames)...`;

            // Yield to let the UI update before the heavy rendering
            await new Promise(r => setTimeout(r, 50));

            // 2. Render both blink phases
            const frame0 = renderFrame(pixels, 0);
            const frame1 = renderFrame(pixels, 1);

            status.textContent = '> Encoding GIF...';
            await new Promise(r => setTimeout(r, 50));

            // 3. Load gifenc dynamically (only when needed)
            const { GIFEncoder, quantize, applyPalette } =
                await import('https://cdn.jsdelivr.net/npm/gifenc@1.0.3/+esm');

            // 4. Encode 2-frame animated GIF, 1000ms per frame (1 fps)
            const gif = GIFEncoder();

            for (const frame of [frame0, frame1]) {
                const ctx = frame.getContext('2d');
                const { data } = ctx.getImageData(0, 0, W, H);
                const palette = quantize(data, 256);
                const index = applyPalette(data, palette);
                gif.writeFrame(index, W, H, { palette, delay: 1000 });
            }

            gif.finish();
            const bytes = gif.bytes();

            // 5. Trigger download
            const blob = new Blob([bytes], { type: 'image/gif' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = 'graffiti-wall.gif';
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);

            const sizeKB = Math.round(bytes.length / 1024);
            status.textContent = `> Exported: graffiti-wall.gif (${sizeKB} KB, 2 frames @ 1fps)`;

            // Release offscreen canvases
            frame0.width = frame0.height = 0;
            frame1.width = frame1.height = 0;

        } catch (err) {
            console.error('Wall export failed:', err);
            status.textContent = `> ERROR: ${err.message}`;
        } finally {
            btn.disabled = false;
        }
    }

    // Wire up when the admin content is visible (after login)
    function init() {
        const btn = document.getElementById('export-wall-btn');
        if (btn) btn.addEventListener('click', exportWallGif);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
