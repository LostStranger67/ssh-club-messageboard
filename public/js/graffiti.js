document.addEventListener("DOMContentLoaded", () => {
    const wall = document.getElementById('wall-container');
    const canvas = document.getElementById('wall-canvas');
    const staticCtx = canvas.getContext('2d');
    const cursor = document.getElementById('cursor');
    const coordsDisplay = document.getElementById('coords');
    const paletteContainer = document.getElementById('palette-bar');
    const newsMarquee = document.getElementById('news-marquee');
    const newsScroll = document.getElementById('news-scroll');

    // --- News marquee (entries managed from the radio admin page) ---
    async function loadNews() {
        try {
            const res = await fetch('/radio/api/news');
            const data = await res.json();
            const items = (data.news || []).map(n => n.text).filter(t => t.trim());
            if (items.length === 0) { newsMarquee.hidden = true; return; }
            newsMarquee.hidden = false;
            // Repeat items until the strip is wide enough to cover the viewport,
            // then double it for a seamless -50% loop (like the radio docket).
            // Each item renders its approved [color]/[blink] tags to spans;
            // NewsFormat escapes everything else first, so innerHTML is safe.
            const plain = items.join(' /// ');
            const repeat = Math.max(3, Math.ceil(1200 / Math.max(1, plain.length)));
            const joined = items.map(t => NewsFormat.render(t)).join(' /// ');
            const half = Array(repeat).fill(joined).join(' /// ');
            newsScroll.innerHTML = half + ' /// ' + half;
            // Slow-ish, constant speed (~60px/s) regardless of strip length
            newsScroll.style.animationDuration = Math.max(40, newsScroll.scrollWidth / 60) + 's';
        } catch (e) {
            newsMarquee.hidden = true;
        }
    }
    loadNews();
    setInterval(loadNews, 300000); // refresh every 5 minutes, like the docket

    // Config matches server
    const COLS = 300;
    const ROWS = 150;
    // Must match #wall-container { font-size } — used for the sprite font size
    const FONT_SIZE = 15;

    // --- Color Palette ---
    // Add new colors here; indices are used in the database, so this
    // array must never be reordered (existing wall pixels reference it
    // by index, blink pixels store a*10+b pairs of these indices).
    // Format: { hex: '#RRGGBB', label: 'Short name' }
    const PALETTE = [
        { hex: '#00ff41', label: 'Green' },
        { hex: '#ff44cc', label: 'Pink' },
        { hex: '#00ccff', label: 'Cyan' },
        { hex: '#ffcc00', label: 'Yellow' },
        { hex: '#ff8800', label: 'Orange' },
        { hex: '#aa00ff', label: 'Purple' },
        { hex: '#ffffff', label: 'White' },
        { hex: '#ff2200', label: 'Red' },
    ];

    // Order of the swatches on screen: red → orange → yellow → green →
    // blue → purple → pink → white (DB indices, not a reorder of PALETTE)
    const DISPLAY_ORDER = [7, 4, 3, 0, 2, 5, 1, 6];

    // Rainbow mode (Ctrl+0) spectrum: same order, but pink and white
    // are skipped — only the rainbow colors cycle
    const RAINBOW_ORDER = [7, 4, 3, 0, 2, 5]; // red orange yellow green blue purple

    // --- Blink Mode (keyboard only, no palette button) ---
    // Toggle with Ctrl+9, exactly like rainbow mode (Ctrl+0).
    // While ON, every character you type blinks between the LAST TWO
    // real colors you picked (1s each, hard cuts, neon glow):
    //   pick green → pick purple → Ctrl+9 → type: blinks green↔purple
    //   pick blue → pick red → Ctrl+9 → type: blinks blue↔red
    // Each blink pixel stores its own pair in the single DB color column:
    //   BLINK_BASE + firstColor * 10 + secondColor
    // e.g. 805 = 800 + 0*10 + 5 → blinks green↔purple
    // so the pair persists per-pixel and every client renders it.
    // If you haven't picked two colors yet, it falls back to red/blue.
    const BLINK_BASE = 800;
    const LEGACY_BLINK = 8; // old fixed red/blue pixels stored plain 8
    // Blink cycle: 1s per color, hard cuts, aligned to the wall clock so
    // every client (and every blink pixel) flips at the same instants.
    const BLINK_PHASE_MS = 1000;

    let selectedColorIndex = 0;
    let rainbowMode = false;  // Secret rainbow mode: each keystroke cycles color
    let blinkMode = false;    // Blink mode: typed chars blink the last two picked colors
    let colorHistory = [];    // real colors picked by the user, most recent last

    function isBlinkValue(v) {
        return v === LEGACY_BLINK || v >= BLINK_BASE;
    }

    // The last two colors you picked become the blink colors
    function blinkPair() {
        if (colorHistory.length >= 2) {
            return [colorHistory[colorHistory.length - 2], colorHistory[colorHistory.length - 1]];
        }
        if (colorHistory.length === 1) {
            return [colorHistory[0], colorHistory[0]];
        }
        return [7, 2]; // nothing picked yet: classic red/blue
    }

    function blinkValue() {
        const [a, b] = blinkPair();
        return BLINK_BASE + a * 10 + b;
    }

    function buildPaletteUI() {
        DISPLAY_ORDER.forEach(idx => {
            const c = PALETTE[idx];
            const btn = document.createElement('button');
            btn.className = 'palette-btn';
            btn.style.backgroundColor = c.hex;
            btn.style.boxShadow = `0 0 4px ${c.hex}`;
            btn.title = c.label;
            btn.dataset.index = idx;
            btn.addEventListener('click', () => selectColor(idx));
            paletteContainer.appendChild(btn);
        });
        selectColor(DISPLAY_ORDER[0], false); // first visible swatch (red)
    }

    function selectColor(idx, fromUser = true) {
        if (fromUser) {
            // Remember color picks; the last two feed the blink pair
            colorHistory.push(idx);
            if (colorHistory.length > 8) colorHistory.shift();
        }
        selectedColorIndex = idx;
        document.querySelectorAll('.palette-btn').forEach(btn => {
            const i = parseInt(btn.dataset.index, 10);
            btn.classList.toggle('selected', i === idx);
        });
    }

    // --- State & Canvas Renderer ---
    // The wall is three transparent canvases stacked in #wall-container
    // (bottom to top):
    //   #wall-grid    grid lines — repainted only on resize / theme change
    //   #wall-canvas  static (non-blinking) glyphs
    //   #wall-blink   blinking glyphs, drawn at the current wall-clock phase
    //
    // Each glyph layer is ALWAYS fully cleared and repainted in strict
    // row-major order. There is no partial/neighborhood repaint and no
    // shared-canvas interleave, so overlapping glow halos can never
    // accumulate, flicker, or depend on redraw order — the final pixels
    // depend only on the wall content.
    //
    // Glyph sprites are baked at 1:1 natural size (never scaled) in a box
    // derived from the font size + the widest glow, so caps (T) and glows
    // can never be clipped by the sprite box at any devicePixelRatio.
    const gridLayer = document.getElementById('wall-grid');
    const blinkLayer = document.getElementById('wall-blink');
    const gridCtx = gridLayer.getContext('2d');
    const blinkCtx = blinkLayer.getContext('2d');

    const state = new Map();        // "x,y" -> { char, color, brightness }
    const staticCells = new Map();  // "x,y" -> {x,y}, non-blink cells (static layer source)
    const blinkCells = new Set();   // keys of blink-encoded pixels (blink layer source)
    const sprites = new Map();      // "gl|colorIdx|char" / "bl|colorIdx|char" -> canvas (LRU)
    const SPRITE_CAP = 2000;
    let dirtyStatic = false;
    let dirtyBlink = false;
    let rafPending = false;
    let dpr = 1;
    let lastDpr = 1;
    let fontPx = FONT_SIZE;
    let padX = 20, padY = 24;       // sprite box half-extents (device px)
    let fontStack = 'monospace';
    let gridColor = '#00cc00';
    let currentPhase = 0;           // 0 = first blink color, 1 = second

    // The grid is 7% of the theme accent, like the old CSS gradient was
    function readTheme() {
        const v = getComputedStyle(document.documentElement).getPropertyValue('--color-accent').trim();
        if (v) gridColor = v;
    }

    const keyOf = (x, y) => x + ',' + y;
    const parseKey = k => k.split(',').map(Number);

    function scheduleFlush() {
        if (rafPending) return;
        rafPending = true;
        requestAnimationFrame(flushDirty);
    }

    // rAF-coalesced layer repaints: any number of cell changes per frame
    // cost at most one full redraw of the affected layers.
    function flushDirty() {
        rafPending = false;
        if (dirtyStatic) {
            dirtyStatic = false;
            redrawStatic();
        }
        if (dirtyBlink) {
            dirtyBlink = false;
            redrawBlink();
        }
    }

    // Keys of a cell set in strict row-major order (y, then x) — the only
    // order ever used to composite a layer, so every repaint is
    // bit-identical.
    function rowMajor(keys) {
        return [...keys].map(parseKey).sort((a, b) => a[1] - b[1] || a[0] - b[0]);
    }

    // Render one glyph+glow into an offscreen canvas at 1:1 natural size,
    // cached per (glow style, color, char). The expensive blur happens once
    // per combo. The box is padded well beyond the glyph ink + glow
    // (see padX/padY in resizeCanvas), so nothing is ever cut by the box.
    function makeSprite(glow, colorIdx, ch) {
        const k = glow + '|' + colorIdx + '|' + ch;
        let s = sprites.get(k);
        if (s) {
            sprites.delete(k); // refresh LRU position
            sprites.set(k, s);
            return s;
        }
        const hex = (PALETTE[colorIdx] || PALETTE[0]).hex;
        s = document.createElement('canvas');
        s.width = padX * 2;
        s.height = padY * 2;
        const c = s.getContext('2d');
        c.font = `${fontPx}px ${fontStack}`;
        c.textAlign = 'center';
        c.textBaseline = 'middle';
        c.fillStyle = hex;
        c.shadowColor = hex;
        if (glow === 'bl') {
            // Blink pixels: two passes to mimic the 3px + 10px text-shadow
            c.shadowBlur = 3 * dpr;
            c.fillText(ch, s.width / 2, s.height / 2);
            c.shadowBlur = 10 * dpr;
            c.fillText(ch, s.width / 2, s.height / 2);
        } else {
            c.shadowBlur = 2 * dpr;
            c.fillText(ch, s.width / 2, s.height / 2);
        }
        sprites.set(k, s);
        while (sprites.size > SPRITE_CAP) {
            sprites.delete(sprites.keys().next().value);
        }
        return s;
    }

    // Cell edges on the floor of the exact fractions — the same ruler the
    // click mapping (getCoords) uses, so clicks, glyphs and grid lines
    // share one geometry.
    function cellRect(x, y) {
        const left = Math.floor((x * canvas.width) / COLS);
        const right = Math.floor(((x + 1) * canvas.width) / COLS);
        const top = Math.floor((y * canvas.height) / ROWS);
        const bottom = Math.floor(((y + 1) * canvas.height) / ROWS);
        return {
            x: left,
            y: top,
            w: right - left,
            h: bottom - top
        };
    }

    // Rounded center of a cell, from the same floor edges. Integer centers
    // keep 1:1 blits on stable pixel positions (no per-cell shimmer).
    function cellCenter(x, y) {
        const r = cellRect(x, y);
        return [Math.round(r.x + r.w / 2), Math.round(r.y + r.h / 2)];
    }

    function drawGridCell(gctx, r) {
        const lw = Math.max(1, Math.round(dpr)); // 1 CSS px, in device px
        gctx.globalAlpha = 0.07;
        gctx.fillStyle = gridColor;
        gctx.fillRect(r.x, r.y, lw, r.h);   // left edge line
        gctx.fillRect(r.x, r.y, r.w, lw);   // top edge line
        gctx.globalAlpha = 1;
    }

    // The grid lives on its own layer: full canvas, one pass, floor-based
    // cells — no seams, and it is only ever redrawn on resize / theme swap.
    function redrawGrid() {
        gridCtx.clearRect(0, 0, gridLayer.width, gridLayer.height);
        for (let y = 0; y < ROWS; y++) {
            for (let x = 0; x < COLS; x++) {
                drawGridCell(gridCtx, cellRect(x, y));
            }
        }
    }

    function blitCell(bctx, x, y) {
        const e = state.get(keyOf(x, y));
        if (!e) return;
        let glow, colorIdx;
        if (isBlinkValue(e.color)) {
            const v = e.color === LEGACY_BLINK ? BLINK_BASE + 7 * 10 + 2 : e.color;
            colorIdx = currentPhase ? (v - BLINK_BASE) % 10 : Math.floor((v - BLINK_BASE) / 10);
            glow = 'bl';
        } else {
            glow = 'gl';
            colorIdx = e.color;
        }
        bctx.globalAlpha = Math.max(0, Math.min(1, e.brightness));
        // 1:1 blit centered on the cell — no scaling, no clipping
        const [cx, cy] = cellCenter(x, y);
        const s = makeSprite(glow, colorIdx, e.char);
        bctx.drawImage(s, cx - s.width / 2, cy - s.height / 2);
        bctx.globalAlpha = 1;
    }

    function redrawStatic() {
        staticCtx.clearRect(0, 0, canvas.width, canvas.height);
        for (const [x, y] of rowMajor(staticCells.keys())) {
            blitCell(staticCtx, x, y);
        }
    }

    function redrawBlink() {
        blinkCtx.clearRect(0, 0, blinkLayer.width, blinkLayer.height);
        for (const [x, y] of rowMajor(blinkCells)) {
            blitCell(blinkCtx, x, y);
        }
    }

    function fullRedraw() {
        dirtyStatic = false;
        dirtyBlink = false;
        redrawGrid();
        redrawStatic();
        redrawBlink();
    }

    // Single wall-clock-aligned ticker drives ALL blink pixels (replaces
    // thousands of independent CSS animations). Reschedules at the next
    // 1s boundary so every client flips at the same instants. A phase
    // flip is one full repaint of the blink layer only — the static layer
    // is untouched, so static content can never change underneath it.
    function tickBlink() {
        const now = Date.now();
        const p = Math.floor(now / BLINK_PHASE_MS) % 2;
        if (p !== currentPhase) {
            currentPhase = p;
            if (blinkCells.size > 0) markDirtyBlink();
        }
        const next = (Math.floor(now / BLINK_PHASE_MS) + 1) * BLINK_PHASE_MS + 25;
        setTimeout(tickBlink, Math.max(20, next - Date.now()));
    }

    function markDirtyStatic() {
        dirtyStatic = true;
        scheduleFlush();
    }

    function markDirtyBlink() {
        dirtyBlink = true;
        scheduleFlush();
    }

    function setPixel(x, y, char, brightness, color) {
        brightness = (brightness != null) ? brightness : 1;
        color = (color != null) ? color : 0;
        const k = keyOf(x, y);

        if (!char || char === ' ') {
            if (state.has(k)) {
                state.delete(k);
                staticCells.delete(k);
                blinkCells.delete(k);
                // removal may affect either layer
                markDirtyStatic();
                markDirtyBlink();
            }
            return;
        }

        const prev = state.get(k);
        const wasBlink = prev ? isBlinkValue(prev.color) : false;
        const isBlink = isBlinkValue(color);

        state.set(k, { char, color, brightness });
        if (isBlink) {
            staticCells.delete(k);
            blinkCells.add(k);
        } else {
            blinkCells.delete(k);
            staticCells.set(k, { x, y });
        }

        markDirtyStatic();
        if (isBlink || wasBlink) markDirtyBlink();
    }

    // Name kept for call-site familiarity (undo, typing)
    function renderPixel(x, y, char, brightness, color) {
        setPixel(x, y, char, brightness, color);
    }

    function getPixelData(x, y) {
        const e = state.get(keyOf(x, y));
        if (!e) return { char: ' ', color: 0 };
        return { char: e.char, color: e.color };
    }

    function resizeCanvas() {
        dpr = window.devicePixelRatio || 1;
        fontPx = Math.round(FONT_SIZE * dpr);
        const w = Math.max(1, Math.round(wall.clientWidth * dpr));
        const h = Math.max(1, Math.round(wall.clientHeight * dpr));
        if (canvas.width === w && canvas.height === h && dpr === lastDpr) return;
        lastDpr = dpr;
        for (const c of [gridLayer, canvas, blinkLayer]) {
            c.width = w;
            c.height = h;
            c.style.width = wall.clientWidth + 'px';
            c.style.height = wall.clientHeight + 'px';
        }

        // 1:1 sprite box: headroom for the tallest/widest ink (incl. emoji)
        // plus the widest glow (blink blur = 10*dpr; visible spread is
        // roughly 0.6x the blur radius). Every term scales with dpr, so the
        // box-to-ink ratio is identical at any devicePixelRatio — clipping
        // is impossible (audited against every char on the live wall).
        padX = Math.ceil(0.7 * fontPx + 0.6 * 10 * dpr + 3 * dpr);
        padY = Math.ceil(0.9 * fontPx + 0.6 * 10 * dpr + 3 * dpr);
        padX += padX % 2; // even boxes → integer-centered blits
        padY += padY % 2;

        sprites.clear(); // glyph metrics depend on pixel size
        fullRedraw();
    }

    // --- Undo System ---

    const undoStack = [];

    function pushUndo(changes) {
        // changes: Array of { x, y, char, color } representing the state BEFORE the change
        if (undoStack.length > 50) undoStack.shift();
        undoStack.push(changes);
    }

    function performUndo() {
        if (undoStack.length === 0) return;
        const lastBatch = undoStack.pop();

        // 1. Revert visuals (coalesced by the dirty-cell rAF flush)
        lastBatch.forEach(p => {
            setPixel(p.x, p.y, p.char, 1.0, p.color);
        });

        // 2. Send reverts to server
        lastBatch.forEach(p => {
            pendingUpdates.push({ x: p.x, y: p.y, char: p.char, color: p.color });
        });
        clearTimeout(bufferTimeout);
        flushBuffer();
    }

    // --- Selection Logic ---

    // Selection overlay (one DOM node, positioned in the same ch/em grid)
    const selectionBox = document.createElement('div');
    selectionBox.className = 'selection-box';
    wall.appendChild(selectionBox);

    function updateSelectionVisuals() {
        if (!selectionStart || !selectionEnd) {
            selectionBox.style.display = 'none';
            return;
        }

        const minX = Math.min(selectionStart.x, selectionEnd.x);
        const maxX = Math.max(selectionStart.x, selectionEnd.x);
        const minY = Math.min(selectionStart.y, selectionEnd.y);
        const maxY = Math.max(selectionStart.y, selectionEnd.y);

        selectionBox.style.left = `${minX}ch`;
        selectionBox.style.top = `${minY}em`;
        selectionBox.style.width = `${(maxX - minX + 1)}ch`;
        selectionBox.style.height = `${(maxY - minY + 1)}em`;
        selectionBox.style.display = 'block';
    }

    async function copySelection() {
        if (!selectionStart || !selectionEnd) return;

        const minX = Math.min(selectionStart.x, selectionEnd.x);
        const maxX = Math.max(selectionStart.x, selectionEnd.x);
        const minY = Math.min(selectionStart.y, selectionEnd.y);
        const maxY = Math.max(selectionStart.y, selectionEnd.y);

        let textBlob = "";
        for (let y = minY; y <= maxY; y++) {
            let rowStr = "";
            for (let x = minX; x <= maxX; x++) {
                rowStr += getPixelData(x, y).char;
            }
            textBlob += rowStr.replace(/\s+$/, '') + "\n";
        }

        try {
            await navigator.clipboard.writeText(textBlob);
            const originalColor = selectionBox.style.backgroundColor;
            selectionBox.style.backgroundColor = 'rgba(255, 255, 255, 0.6)';
            setTimeout(() => { selectionBox.style.backgroundColor = originalColor; }, 150);
        } catch (err) {
            console.error("Copy failed:", err);
        }
    }

    function deleteSelection() {
        if (!selectionStart || !selectionEnd) return;

        const minX = Math.min(selectionStart.x, selectionEnd.x);
        const maxX = Math.max(selectionStart.x, selectionEnd.x);
        const minY = Math.min(selectionStart.y, selectionEnd.y);
        const maxY = Math.max(selectionStart.y, selectionEnd.y);

        const undoBatch = [];

        for (let y = minY; y <= maxY; y++) {
            for (let x = minX; x <= maxX; x++) {
                const data = getPixelData(x, y);
                if (data.char !== ' ') {
                    undoBatch.push({ x, y, char: data.char, color: data.color });
                    addCharToBuffer(x, y, ' ');
                }
            }
        }

        if (undoBatch.length > 0) pushUndo(undoBatch);

        selectionStart = null;
        selectionEnd = null;
        updateSelectionVisuals();
    }

    // --- Cursor & Hit Testing ---

    function updateCursor() {
        cursor.style.left = `${cursorX}ch`;
        cursor.style.top = `${cursorY}em`;
        coordsDisplay.innerText = `${cursorX},${cursorY}`;
    }

    function getCoords(e) {
        // Map against the CANVAS rect (not the wall's): the canvas sits one
        // border-width inside the wall, and its CSS box is what the backing
        // store scales onto, so this is the exact ruler the renderer uses.
        const rect = canvas.getBoundingClientRect();
        let x = Math.floor((e.clientX - rect.left) / (rect.width / COLS));
        let y = Math.floor((e.clientY - rect.top) / (rect.height / ROWS));

        if (x < 0) x = 0; if (x >= COLS) x = COLS - 1;
        if (y < 0) y = 0; if (y >= ROWS) y = ROWS - 1;

        return { x, y };
    }

    let cursorX = 0;
    let cursorY = 0;

    // --- Tools State ---
    let isSelecting = false;
    let selectionStart = null; // {x, y}
    let selectionEnd = null;   // {x, y}

    wall.addEventListener('mousedown', (e) => {
        const c = getCoords(e);
        cursorX = c.x;
        cursorY = c.y;
        updateCursor();

        isSelecting = true;
        selectionStart = { x: cursorX, y: cursorY };
        selectionEnd = { x: cursorX, y: cursorY };
        updateSelectionVisuals();
    });

    window.addEventListener('mousemove', (e) => {
        if (!isSelecting) return;

        const rect = wall.getBoundingClientRect();
        if (e.clientX < rect.left - 50 || e.clientX > rect.right + 50 ||
            e.clientY < rect.top - 50 || e.clientY > rect.bottom + 50) return;

        const c = getCoords(e);

        if (c.x !== selectionEnd.x || c.y !== selectionEnd.y) {
            selectionEnd = c;
            updateSelectionVisuals();

            cursorX = c.x;
            cursorY = c.y;
            updateCursor();
        }
    });

    window.addEventListener('mouseup', () => {
        isSelecting = false;
    });

    // Capture typing
    let pendingUpdates = []; // Buffer for typing
    let bufferTimeout = null;

    document.addEventListener('keydown', (e) => {
        // Shortcuts

        // Ctrl+9: toggle blink mode (typed chars blink the last two picked colors)
        if ((e.ctrlKey || e.metaKey) && e.key === '9') {
            e.preventDefault();
            blinkMode = !blinkMode;
            return;
        }

        // Ctrl+1 through Ctrl+8: switch color, following the visible
        // swatch order (1 → first swatch = red, 2 → orange, ...)
        if ((e.ctrlKey || e.metaKey) && e.key >= '1' && e.key <= '8') {
            e.preventDefault();
            selectColor(DISPLAY_ORDER[parseInt(e.key, 10) - 1]);
            return;
        }

        // Ctrl+0: toggle secret rainbow mode (each keystroke cycles color)
        if ((e.ctrlKey || e.metaKey) && e.key === '0') {
            e.preventDefault();
            rainbowMode = !rainbowMode;
            return;
        }

        // Undo: Ctrl+Z
        if ((e.ctrlKey || e.metaKey) && e.key === 'z') {
            e.preventDefault();
            performUndo();
            return;
        }

        // Copy: Ctrl+C
        if ((e.ctrlKey || e.metaKey) && e.key === 'c') {
            if (selectionStart) {
                e.preventDefault();
                copySelection();
            }
            return;
        }

        // Delete / Backspace
        if (e.key === 'Delete' || e.key === 'Backspace') {
            if (selectionStart && selectionStart !== selectionEnd) {
                e.preventDefault();
                deleteSelection();
                return;
            }
        }

        // Only type if we aren't using modifier keys (Cmd/Ctrl)
        if (e.metaKey || e.ctrlKey || e.altKey) return;

        // Handle Keys
        if (e.key.length === 1) {
            if (e.key === " ") e.preventDefault();

            // Cycle color in rainbow mode (red→orange→yellow→green→blue→
            // purple; pink/white excluded; any non-rainbow color restarts at red)
            if (rainbowMode) {
                const pos = RAINBOW_ORDER.indexOf(selectedColorIndex);
                selectColor(RAINBOW_ORDER[(pos + 1) % RAINBOW_ORDER.length]);
            }

            // Save current state before overwriting
            const existingData = getPixelData(cursorX, cursorY);
            pushUndo([{
                x: cursorX,
                y: cursorY,
                char: existingData.char,
                color: existingData.color
            }]);

            addCharToBuffer(cursorX, cursorY, e.key);

            cursorX++;
            if (cursorX >= COLS) {
                cursorX = 0;
                cursorY++;
                if (cursorY >= ROWS) cursorY = 0;
            }
            updateCursor();

            selectionStart = null;
            updateSelectionVisuals();
        }
        else if (e.key === 'Backspace') {
            e.preventDefault();
            cursorX--;
            if (cursorX < 0) {
                cursorX = COLS - 1;
                cursorY--;
                if (cursorY < 0) cursorY = 0;
            }

            const existingData = getPixelData(cursorX, cursorY);
            pushUndo([{
                x: cursorX,
                y: cursorY,
                char: existingData.char,
                color: existingData.color
            }]);

            addCharToBuffer(cursorX, cursorY, ' ');
            updateCursor();
        }
        else if (e.key === 'Enter') {
            e.preventDefault();
            if (cursorY < ROWS - 1) cursorY++;
            cursorX = 0;
            updateCursor();
        }
        else if (e.key === 'ArrowUp') {
            e.preventDefault();
            if (cursorY > 0) cursorY--;
            updateCursor();
        }
        else if (e.key === 'ArrowDown') {
            e.preventDefault();
            if (cursorY < ROWS - 1) cursorY++;
            updateCursor();
        }
        else if (e.key === 'ArrowLeft') {
            e.preventDefault();
            if (cursorX > 0) cursorX--;
            updateCursor();
        }
        else if (e.key === 'ArrowRight') {
            e.preventDefault();
            if (cursorX < COLS - 1) cursorX++;
            updateCursor();
        }
    });

    document.addEventListener('paste', (e) => {
        e.preventDefault();

        const text = (e.clipboardData || window.clipboardData).getData('text');
        if (!text) return;

        const lines = text.split('\n');
        const startX = cursorX;
        const startY = cursorY;

        const undoBatch = [];

        lines.forEach((line, rowIndex) => {
            const targetY = startY + rowIndex;
            if (targetY >= ROWS) return;
            const chars = [...line];

            chars.forEach((char, colIndex) => {
                const targetX = startX + colIndex;
                if (targetX >= COLS) return;
                if (char.match(/[\r\n\t]/)) return;

                undoBatch.push({
                    x: targetX,
                    y: targetY,
                    char: getPixelData(targetX, targetY).char,
                    color: getPixelData(targetX, targetY).color
                });

                addCharToBuffer(targetX, targetY, char);
            });
        });

        if (undoBatch.length > 0) pushUndo(undoBatch);

        cursorY = Math.min(ROWS - 1, startY + lines.length - 1);
        const lastLineLength = (lines[lines.length - 1] || '').length;
        cursorX = Math.min(COLS - 1, startX + lastLineLength);

        updateCursor();
        clearTimeout(bufferTimeout);
        flushBuffer();
    });

    // --- Data Transmission ---

    function addCharToBuffer(x, y, char) {
        // Blink mode encodes the current pair; plain colors store their index
        const colorValue = blinkMode ? blinkValue() : selectedColorIndex;

        // optimistic rendering (coalesced to one repaint per frame)
        setPixel(x, y, char, 1.0, colorValue);

        // Add to batch
        pendingUpdates.push({ x, y, char, color: colorValue });

        // Debounce sending
        clearTimeout(bufferTimeout);
        bufferTimeout = setTimeout(flushBuffer, 500);
    }

    // A whole-wall paste is 45k cells. The server accepts up to four walls per
    // request, but we still send in chunks: it keeps each request body and each
    // server-side DB transaction small, and one failed chunk no longer takes the
    // whole artwork down with it.
    const SEND_CHUNK_SIZE = 10000;

    async function flushBuffer() {
        if (pendingUpdates.length === 0) return;

        const payload = [...pendingUpdates];
        pendingUpdates = [];

        for (let i = 0; i < payload.length; i += SEND_CHUNK_SIZE) {
            const chunk = payload.slice(i, i + SEND_CHUNK_SIZE);
            try {
                const res = await fetch('/api/graffiti', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ pixels: chunk })
                });
                if (!res.ok) {
                    console.error(`Graffiti chunk rejected: ${res.status} ${await res.text()}`);
                    warnSaveFailure();
                    break; // server is unhappy — don't hammer it with the rest
                }
            } catch (err) {
                console.error(err);
                warnSaveFailure();
                break;
            }
        }
    }

    // Last-resort visibility: a silently dropped paste is exactly what this
    // whole saga started as — show a small banner if a save failed.
    let saveWarnTimer = null;
    function warnSaveFailure() {
        let el = document.getElementById('save-fail-warning');
        if (!el) {
            el = document.createElement('div');
            el.id = 'save-fail-warning';
            el.textContent = '⚠ your paint failed to save — keep this tab open and try again, or reload';
            el.style.cssText = 'position:fixed;top:8px;left:50%;transform:translateX(-50%);' +
                'background:#5c0000;color:#fff;padding:8px 16px;z-index:9999;font-family:monospace;' +
                'border:1px solid #ff4444;box-shadow:0 0 12px #ff2200;pointer-events:none;';
            document.body.appendChild(el);
        }
        el.style.display = 'block';
        clearTimeout(saveWarnTimer);
        saveWarnTimer = setTimeout(() => { el.style.display = 'none'; }, 8000);
    }

    // Do not lose the last <500ms of typing when the tab is closed/backgrounded
    window.addEventListener('pagehide', () => {
        if (pendingUpdates.length > 0) flushBuffer();
    });

    // --- Realtime Updates (SSE) ---
    const eventSource = new EventSource('/api/updates');
    eventSource.addEventListener('graffitiUpdate', (e) => {
        // setPixel coalesces all bursts into a single layer repaint
        const incomingPixels = JSON.parse(e.data);
        incomingPixels.forEach(p => {
            setPixel(p.x, p.y, p.char, p.brightness, p.color);
        });
    });

    // The server decay job (every 48 hours) uses exactly the same math on
    // the DB, so we mirror it on the local state to keep them in sync while
    // the tab stays open; a reconnect refetch fixes any drift anyway.
    // multiply brightness, drop what fell below the visibility threshold.
    // A full repaint once every couple of hours is trivial.
    eventSource.addEventListener('graffitiDecay', (e) => {
        const { factor = 0.7, threshold = 0.1 } = JSON.parse(e.data) || {};
        for (const [k, entry] of state) {
            entry.brightness *= factor;
            if (entry.brightness < threshold) {
                state.delete(k);
                staticCells.delete(k);
                blinkCells.delete(k);
            }
        }
        fullRedraw();
    });

    // --- Initialization ---

    async function loadWall() {
        try {
            const res = await fetch('/api/graffiti');
            const data = await res.json(); // [[x, y, char, brightness, color], ...]
            state.clear();
            staticCells.clear();
            blinkCells.clear();
            for (const [x, y, ch, bri, ci] of data) {
                if (!ch || ch === ' ') continue; // spaces hold no state, just absence
                const k = keyOf(x, y);
                state.set(k, { char: ch, color: ci, brightness: bri });
                if (isBlinkValue(ci)) blinkCells.add(k);
                else staticCells.set(k, { x, y });
            }
            fullRedraw();
        } catch (e) {
            console.error(e);
        }
    }

    function init() {
        // Use the site's own font stack so canvas glyphs match the DOM grid
        const style = getComputedStyle(document.documentElement);
        fontStack = (style.getPropertyValue('--font-family') || 'monospace').trim();
        readTheme();

        buildPaletteUI();
        resizeCanvas();
        new ResizeObserver(resizeCanvas).observe(wall);
        // Zoom/dpr changes that don't resize the wall box (display scaling,
        // window moved to another monitor) still need a backing-store update
        window.addEventListener('resize', resizeCanvas);
        // theme swaps change the grid tint — repaint the grid layer only;
        // the glyph layers are theme-independent (fixed palette + brightness)
        new MutationObserver(() => {
            readTheme();
            redrawGrid();
        }).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
        tickBlink();
        loadWall();
        updateCursor();
    }

    // Wait for the webfont (if it is ever wired up) so the first sprites use
    // the right face; 1.5s cap so a slow font never blocks the wall.
    Promise.race([
        document.fonts.ready,
        new Promise(resolve => setTimeout(resolve, 1500))
    ]).then(init);
});
