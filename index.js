const fs = require('fs');
require('dotenv').config();
const crypto = require('crypto');
const express = require('express');
const multer = require('multer');
const path = require('path');
const http = require('http'); // Use the built-in http module
const { fileTypeFromFile } = require('file-type');
const sharp = require('sharp');
const { EventEmitter } = require('events');

const { execFile } = require('child_process');
const ffmpegPath = require('ffmpeg-static');

const { createProxyMiddleware } = require('http-proxy-middleware');
const { rateLimit } = require('express-rate-limit');

// --- Database and Real-time Setup ---
const db = require('./database/database.js');
const events = new EventEmitter();
events.setMaxListeners(0);

const app = express();
app.disable('x-powered-by');
// Topology: nginx (public) forwards to this app over WireGuard only — every
// connection to this port is either loopback or a private-VPN peer, and
// nothing else on earth can reach it. Trusting private ranges for
// X-Forwarded-For is therefore safe and gives the rate limiters real
// per-client IPs (with trust off, EVERY visitor collapses into nginx's
// single bucket); forging XFF requires already being inside the VPN.
app.set('trust proxy', 'uniquelocal');

// Basic HTTP security headers (applied to every response)
app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    // CSP: same-origin for everything; 'unsafe-inline' is unavoidable while
    // the theme switcher uses inline onclick + inline <script> blocks. The
    // single external script is the gifenc module the wall exporter imports.
    res.setHeader('Content-Security-Policy',
        "default-src 'self'; script-src 'self' https://cdn.jsdelivr.net 'unsafe-inline'; " +
        "style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; " +
        "font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'");
    next();
});
const port = parseInt(process.env.PORT || "3000", 10);
const SALT = process.env.HASH_SALT || 'ssh-club-tripcode-salt';
const THREAD_LIMIT = parseInt(process.env.THREAD_LIMIT || "20", 10);

// --- Rate limiting for write endpoints (per IP) ---
const threadLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 10, standardHeaders: true, legacyHeaders: false });
const replyLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 30, standardHeaders: true, legacyHeaders: false });
const deleteLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 20, standardHeaders: true, legacyHeaders: false });
// Graffiti is a canvas, not a form: every keystroke flushes a batch, and a big
// paste is split into a handful of requests. A 15-min lockout at 60 requests
// was far too tight and ate people's art, so the window is short and permissive.
const graffitiLimiter = rateLimit({ windowMs: 5 * 60 * 1000, limit: 500, standardHeaders: true, legacyHeaders: false });

// --- Graffiti Wall Configuration ---
const WALL_WIDTH = 300;  // Characters wide
const WALL_HEIGHT = 150; // Characters high
// A paste can cover the whole wall (WALL_WIDTH * WALL_HEIGHT cells). Allow four
// full walls per request so even a monstrous copy-paste lands in one shot
// instead of getting a 413 (which the client swallowed, so the art just
// "disappeared").
const GRAFFITI_MAX_PIXELS = WALL_WIDTH * WALL_HEIGHT * 4; // 180,000 pixels
// Worst case is ~48 bytes of JSON per pixel (2-char emoji + blink colour code),
// i.e. ~9 MB for the cap above. The default express.json limit is 100kb, which
// rejected pastes of ~2k pixels long before the pixel cap was ever reached.
const GRAFFITI_BODY_LIMIT = '24mb';
const DECAY_INTERVAL_MS = 1000 * 60 * 60 * 24 * 2; // Run decay every 48 hours (change the multiplier as needed)
const DECAY_FACTOR = 0.7; // Lose 30% brightness

// --- Content limits (the trust boundary is the HTTP API, not the form) ---
const MAX_TEXT_LENGTH = 5000;
const MAX_SIGNATURE_LENGTH = 50;
const MAX_SECRET_LENGTH = 72;

// --- Upload directories ---
const UPLOAD_DIR = path.join(__dirname, 'public', 'uploads');        // publicly served, holds only validated files
const STAGING_DIR = path.join(__dirname, 'upload_tmp');              // multer lands here — NOT served, so an in-flight upload can never be fetched
const QUARANTINE_DIR = path.join(__dirname, 'deleted-user-content'); // NOT served — forensic archive of media from deleted posts
[UPLOAD_DIR, STAGING_DIR, QUARANTINE_DIR].forEach(d => {
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
});

const storage = multer.diskStorage({
    destination: STAGING_DIR,
    filename: (_, file, cb) => {
        const namePart = path.parse(file.originalname).name;
        
        let safeName = namePart
            .replace(/\s+/g, '-')              // 1. Turn spaces into dashes
            .replace(/[^a-zA-Z0-9\-_]/g, '');  // 2. Remove anything else (emojis, symbols)

        // Fallback for empty names (e.g. if the filename was just emojis)
        if (!safeName) safeName = 'file';

        // Result: "funny file name.jpg" -> "funny-file-name-1703692200.jpg"
        cb(null, `${safeName}-${Date.now()}${path.extname(file.originalname)}`);
    }
});

const upload = multer({ storage: storage, limits: { fileSize: 20 * 1024 * 1024 } }); // 20MB max

// Staged uploads belong to requests that may never finish (aborted posts,
// crashes between upload and validation) — sweep anything older than an hour.
setInterval(() => {
    fs.readdir(STAGING_DIR, (err, files) => {
        if (err) return;
        const cutoff = Date.now() - 60 * 60 * 1000;
        files.forEach(f => {
            if (!f.includes('-')) return; // only files THIS app staged (name-timestamp.ext)
            const p = path.join(STAGING_DIR, f);
            fs.stat(p, (e, st) => {
                if (!e && st.isFile() && st.mtimeMs < cutoff) fs.unlink(p, () => {});
            });
        });
    });
}, 10 * 60 * 1000).unref();

// Deleted-post media is NOT removed (kept for the owner's audit/forensics
// call) but must not stay publicly retrievable: move it out of the web root
// into QUARANTINE_DIR, keeping the original name for the audit trail.
async function quarantineMedia(urlPath) {
    if (!urlPath || typeof urlPath !== 'string') return;
    const name = path.basename(urlPath);
    if (!name || name === urlPath) return;
    try {
        await fs.promises.rename(path.join(UPLOAD_DIR, name), path.join(QUARANTINE_DIR, name));
        console.log(`Quarantined deleted media: ${name}`);
    } catch (err) {
        if (err.code !== 'ENOENT') console.error(`Could not quarantine ${name}:`, err.message);
    }
}

// --- Serialized transactions ---
// Every write path used to interleave its own BEGIN/COMMIT on the single
// shared sqlite3 connection; under concurrency request B's BEGIN landed
// inside request A's transaction ("cannot start a transaction within a
// transaction") and B's error-path ROLLBACK could undo A's uncommitted work.
// All transactions now run one at a time through this queue.
const dbAsync = {
    get: (sql, params = []) => new Promise((resolve, reject) => db.get(sql, params, (err, row) => err ? reject(err) : resolve(row))),
    run: (sql, params = []) => new Promise((resolve, reject) => db.run(sql, params, function (err) { err ? reject(err) : resolve(this); })),
    all: (sql, params = []) => new Promise((resolve, reject) => db.all(sql, params, (err, rows) => err ? reject(err) : resolve(rows)))
};
let txTail = Promise.resolve();
function withTransaction(work) {
    const result = txTail
        .then(() => dbAsync.run('BEGIN IMMEDIATE TRANSACTION'))
        .then(async () => {
            try {
                const out = await work();
                await dbAsync.run('COMMIT');
                return out;
            } catch (err) {
                try { await dbAsync.run('ROLLBACK'); } catch (_) { }
                throw err;
            }
        });
    txTail = result.catch(() => { });
    return result;
}

db.run(`
    CREATE TABLE IF NOT EXISTS graffiti (
        x INTEGER, 
        y INTEGER, 
        char TEXT, 
        brightness REAL DEFAULT 1.0,
        color INTEGER DEFAULT 0,
        timestamp INTEGER,
        PRIMARY KEY (x, y)
    )
`);

// Migration: add color column if it doesn't exist yet
db.all('PRAGMA table_info(graffiti)', [], (err, columns) => {
    if (err) return console.error('Pragma error:', err);
    const hasColor = columns.some(c => c.name === 'color');
    if (!hasColor) {
        console.log('Migrating graffiti table: adding color column...');
        db.run('ALTER TABLE graffiti ADD COLUMN color INTEGER DEFAULT 0');
    }
});

// Board tables self-bootstrap on first start (same shape as
// database/schema.sql, which documents the schema) — a fresh clone runs
// with zero setup scripts beyond npm install + .env. serialize() because
// node-sqlite3 runs statements in parallel by default, and the CREATE
// INDEX must not race the CREATE TABLE it belongs to.
db.serialize(() => {
    db.run(`
        CREATE TABLE IF NOT EXISTS threads (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            createdAt TEXT NOT NULL,
            lastBump TEXT NOT NULL,
            messageCount INTEGER NOT NULL DEFAULT 0,
            isArchived BOOLEAN NOT NULL DEFAULT 0
        )
    `);
    db.run(`
        CREATE TABLE IF NOT EXISTS messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            threadId INTEGER NOT NULL,
            text TEXT NOT NULL,
            signature TEXT NOT NULL,
            hash TEXT,
            mediaUrl TEXT,
            thumbnailUrl TEXT,
            timestamp TEXT NOT NULL,
            isHeadPost BOOLEAN NOT NULL DEFAULT 0,
            FOREIGN KEY (threadId) REFERENCES threads (id) ON DELETE CASCADE
        )
    `);
    db.run('CREATE INDEX IF NOT EXISTS idx_messages_threadId ON messages (threadId)');
    db.run('CREATE INDEX IF NOT EXISTS idx_threads_lastBump ON threads (lastBump)');
});

// --- Middleware ---
app.use(express.static(path.join(__dirname, 'public')));
// Big graffiti pastes need a bigger JSON body limit. Registered before the
// global parser so it wins for this path (body-parser skips paths it already
// parsed, so ordering here is what makes the limit apply).
app.use('/api/graffiti', express.json({ limit: GRAFFITI_BODY_LIMIT }));
app.use(express.json());

function generateTripcode(secret) {
    const fullHash = crypto.createHash('sha256').update(String(secret ?? '').trim() + SALT).digest('base64url');
    return fullHash.slice(0, 16);
}

app.use('/radio/api', createProxyMiddleware({
    target: 'http://127.0.0.1:3456', // The radio backend
    changeOrigin: true,
    pathRewrite: { '^/radio/api': '/api' }, // Strip /radio prefix
    on: {
        // Forward the REAL client IP (resolved from the socket — trust proxy
        // is off) to the radio backend, which trusts only loopback peers and
        // now sees meaningful per-client rate-limit buckets.
        proxyReq: (proxyReq, req) => {
            proxyReq.setHeader('X-Forwarded-For', req.ip || '127.0.0.1');
        }
    },
    onError: (err, req, res) => {
        console.error('Radio backend proxy error:', err.message);
        res.status(502).json({ error: 'Radio service unavailable' });
    }
}));

// Expected validation failures carry a 400 + a user-safe message; anything
// untagged is an internal error whose details stay in the server log.
function badRequest(message) {
    const e = new Error(message);
    e.status = 400;
    return e;
}

function internalError(res, err) {
    console.error('Internal error:', err && err.message);
    return res.status(500).json({ error: 'Internal server error' });
}

// --- Helper Function (mostly unchanged) ---
async function prepareMessageData(req) {
    let media = null;
    let thumbnail = null;
    const { text, signature, secret } = req.body;

    if ((!text || text.trimEnd() === '') && !req.file) {
        throw badRequest('Message must have text or media.');
    }
    if (text != null && typeof text !== 'string') throw badRequest('Invalid text.');
    if (text && text.length > MAX_TEXT_LENGTH) {
        throw badRequest(`Message too long (max ${MAX_TEXT_LENGTH} characters).`);
    }
    if (signature != null && (typeof signature !== 'string' || signature.length > MAX_SIGNATURE_LENGTH)) {
        throw badRequest(`Signature too long (max ${MAX_SIGNATURE_LENGTH} characters).`);
    }
    if (secret != null && (typeof secret !== 'string' || secret.length > MAX_SECRET_LENGTH)) {
        throw badRequest('Invalid signature code.');
    }

    if (req.file) {
        // ... (file processing and thumbnail logic is the same as your original)
        // This part is well-written and doesn't need to change.
        const originalPath = req.file.path;
        const fileType = await fileTypeFromFile(originalPath);

        const allowedTypes = {
            'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif',
            'video/mp4': 'mp4', 'video/webm': 'webm',
            'audio/mpeg': 'mp3', 'audio/ogg': 'ogg', 'audio/wav': 'wav', 'audio/flac': 'flac'
        };
        if (!fileType || !allowedTypes[fileType.mime]) {
            fs.unlinkSync(originalPath);
            throw badRequest('Invalid file type.');
        }

        const correctExt = allowedTypes[fileType.mime];
        const baseName = path.basename(originalPath, path.extname(originalPath));
        const newFilename = baseName + '.' + correctExt;
        // Validated final home is the served dir; until this move happens the
        // bytes sit in STAGING_DIR where no URL can reach them.
        const newPath = path.join(UPLOAD_DIR, newFilename);
        let thumbPath = null;

        if (originalPath !== newPath) fs.renameSync(originalPath, newPath);

        if (fileType.mime.startsWith('image/')) {
            const thumbFilename = baseName + '_thumb.jpg';
            thumbPath = path.join(UPLOAD_DIR, thumbFilename);
            await sharp(newPath).resize({ width: 200, height: 200, fit: 'inside' }).jpeg({ quality: 80 }).toFile(thumbPath);
        }

        else if (fileType.mime.startsWith('video/')) {
            const thumbFilename = baseName + '_thumb.jpg';
            thumbPath = path.join(UPLOAD_DIR, thumbFilename);

            // Helper: Runs FFmpeg AND checks if it actually made a file
            const extractFrame = (time) => {
                return new Promise((resolve, reject) => {
                    const args = [
                        '-y',                  // Overwrite
                        '-i', newPath,         // Input
                        '-ss', time,           // Time to seek to
                        '-vframes', '1',       // Capture 1 frame
                        '-vf', 'scale=200:-1', // Resize
                        thumbPath              // Output
                    ];

                    execFile(ffmpegPath, args, (error, stdout, stderr) => {
                        if (error) {
                            return reject(error);
                        }
                        
                        // KEY FIX: Check if the file exists and has data
                        try {
                            const stats = fs.statSync(thumbPath);
                            if (stats.size > 0) {
                                resolve();
                            } else {
                                reject(new Error('Generated thumbnail is empty'));
                            }
                        } catch (e) {
                            reject(new Error('Thumbnail file not found'));
                        }
                    });
                });
            };

            // 1. Try 1 second first (avoids black fade-ins)
            try {
                await extractFrame('00:00:01');
            } catch (err) {
                // 2. If that fails (video < 1s or empty output), fallback to start
                console.log('Thumbnail generation at 1s failed/empty, retrying at 0s...');
                try {
                    await extractFrame('00:00:00');
                } catch (retryErr) {
                    // 3. If even 0s fails, just ignore it and leave thumbnail as null
                    // This allows the upload to succeed even if we can't make a preview
                    console.error('Could not generate video thumbnail:', retryErr.message);
                    thumbPath = null;
                }
            }
        }

        media = `/uploads/${newFilename}`;
        thumbnail = thumbPath ? `/uploads/${path.basename(thumbPath)}` : null;
    }

    let tripcode = null;
    if (secret) {
        tripcode = generateTripcode(secret);
    }

    return {
        text: (text || '').trimEnd(),
        signature: signature || 'Anonymous',
        timestamp: new Date().toISOString(),
        hash: tripcode,
        mediaUrl: media,
        thumbnailUrl: thumbnail,
    };
}

// GET a list of all active threads for the main page
app.get('/api/threads', (req, res) => {
    const sql = `
        SELECT
            t.id AS threadId,
            t.messageCount,
            t.lastBump,
            m.text,
            m.signature,
            m.hash,
            m.mediaUrl,
            m.thumbnailUrl,
            m.timestamp
        FROM threads t
        JOIN messages m ON t.id = m.threadId
        WHERE t.isArchived = 0 AND m.isHeadPost = 1
        ORDER BY t.lastBump DESC;
    `;
    db.all(sql, [], (err, rows) => {
        if (err) {
            internalError(res, err);
            return;
        }
        res.json(rows);
    });
});

// GET a specific thread and all its messages
app.get('/api/thread/:threadId', (req, res) => {
    const threadId = parseInt(req.params.threadId, 10);
    const sql = `SELECT * FROM messages WHERE threadId = ? ORDER BY timestamp ASC`;

    db.all(sql, [threadId], (err, messages) => {
        if (err) {
            internalError(res, err);
            return;
        }
        if (messages.length === 0) {
            res.status(404).json({ error: 'Thread not found' });
            return;
        }
        res.json(messages);
    });
});

// POST a new thread
app.post('/api/thread', threadLimiter, upload.single("media"), async (req, res) => {
    try {
        const messageData = await prepareMessageData(req);

        const { newThreadId, messageId } = await withTransaction(async () => {
            const threadResult = await dbAsync.run(
                `INSERT INTO threads (createdAt, lastBump, messageCount) VALUES (?, ?, 1)`,
                [messageData.timestamp, messageData.timestamp]
            );
            const messageResult = await dbAsync.run(
                `INSERT INTO messages (threadId, text, signature, hash, mediaUrl, thumbnailUrl, timestamp, isHeadPost) VALUES (?, ?, ?, ?, ?, ?, ?, 1)`,
                [threadResult.lastID, messageData.text, messageData.signature, messageData.hash, messageData.mediaUrl, messageData.thumbnailUrl, messageData.timestamp]
            );
            return { newThreadId: threadResult.lastID, messageId: messageResult.lastID };
        });

        // After successful commit, handle thread limit
        checkAndArchiveOldestThread();

        // Emit events for real-time updates
        const fullMessage = { id: messageId, threadId: newThreadId, ...messageData, isHeadPost: 1 };
        events.emit('newMessage', { threadId: newThreadId, message: fullMessage });
        events.emit('newThread', { threadId: newThreadId, message: fullMessage });

        res.status(201).json({ status: 'Thread created', threadId: newThreadId });
    } catch (error) {
        if (error.status === 400) return res.status(400).json({ error: error.message });
        console.error('Thread creation failed:', error.message);
        internalError(res, error);
    }
});

// POST a reply to a thread
app.post('/api/thread/:threadId/reply', replyLimiter, upload.single("media"), async (req, res) => {
    try {
        const threadId = parseInt(req.params.threadId, 10);
        if (Number.isNaN(threadId)) return res.status(400).json({ error: 'Invalid thread ID.' });
        const messageData = await prepareMessageData(req);

        // Archived threads are read-only; replying would silently re-bump them
        const thread = await dbAsync.get('SELECT isArchived FROM threads WHERE id = ?', [threadId]);
        if (!thread) return res.status(404).json({ error: 'Thread not found.' });
        if (thread.isArchived) return res.status(400).json({ error: 'This thread is archived.' });

        const messageId = await withTransaction(async () => {
            const messageResult = await dbAsync.run(
                `INSERT INTO messages (threadId, text, signature, hash, mediaUrl, thumbnailUrl, timestamp, isHeadPost) VALUES (?, ?, ?, ?, ?, ?, ?, 0)`,
                [threadId, messageData.text, messageData.signature, messageData.hash, messageData.mediaUrl, messageData.thumbnailUrl, messageData.timestamp]
            );
            await dbAsync.run(
                `UPDATE threads SET lastBump = ?, messageCount = messageCount + 1 WHERE id = ?`,
                [messageData.timestamp, threadId]
            );
            return messageResult.lastID;
        });

        // Emit event for real-time update
        const fullMessage = { id: messageId, threadId, ...messageData, isHeadPost: 0 };
        events.emit('newMessage', { threadId: threadId, message: fullMessage });

        res.status(201).json({ status: 'Post Successful!', message: fullMessage });
    } catch (error) {
        if (error.status === 400) return res.status(400).json({ error: error.message });
        console.error('Reply failed:', error.message);
        internalError(res, error);
    }
});

app.post('/api/delete/:messageID', deleteLimiter, async (req, res) => {
    const messageID = parseInt(req.params.messageID, 10);
    // The "signature code" the poster chose in the form. If they left it
    // blank, the browser generated a random one and cached it, so only that
    // browser can delete — otherwise the code itself proves ownership.
    const secret = typeof req.body?.secret === 'string' ? req.body.secret.trim() : '';
    const tripcode = generateTripcode(secret);

    if (isNaN(messageID)) {
        return res.status(400).json({ error: 'Invalid message ID' });
    }
    if (!secret) {
        return res.status(400).json({ error: 'No signature code provided' });
    }

    try {
        // Ownership check + delete, inside one serialized transaction
        const row = await withTransaction(async () => {
            const r = await dbAsync.get(
                'SELECT isHeadPost, threadId, hash, mediaUrl, thumbnailUrl FROM messages WHERE id = ? AND hash = ?',
                [messageID, tripcode]
            );
            if (!r) return null;

            if (r.isHeadPost) {
                // Soft delete head post
                await dbAsync.run(
                    `UPDATE messages
                     SET text="[DELETED]",
                         signature="[DELETED]",
                         hash="",
                         mediaUrl="",
                         thumbnailUrl=""
                     WHERE id = ?`,
                    [messageID]
                );
            } else {
                // Delete reply
                await dbAsync.run(`DELETE FROM messages WHERE id = ?`, [messageID]);
                await dbAsync.run(
                    `UPDATE threads SET messageCount = messageCount - 1 WHERE id = ?`,
                    [r.threadId]
                );
            }
            return r;
        });

        if (!row) {
            return res.status(403).json({ error: 'Invalid signature code or message not found' });
        }

        // Media is kept for auditing but moved out of the public web root,
        // so a deleted image is no longer fetchable by URL.
        await Promise.all([quarantineMedia(row.mediaUrl), quarantineMedia(row.thumbnailUrl)]);

        return res.json({ success: true });

    } catch (err) {
        console.error('Delete failed:', err.message);
        return internalError(res, err);
    }
});

app.get('/thread/:threadId', (req, res) => {
    const threadId = parseInt(req.params.threadId, 10);

    if (isNaN(threadId)) {
        return res.status(400).send('Invalid thread ID.');
    }

    // Query the database to check if the thread exists.
    const sql = `SELECT id FROM threads WHERE id = ?`;

    db.get(sql, [threadId], (err, row) => {
        if (err) {
            return res.status(500).send('Server error.');
        }
        // If 'row' is undefined, no thread was found.
        if (!row) {
            return res.status(404).send('Thread not found or has been archived.');
        }

        // If the thread exists, send the HTML file.
        const filePath = path.join(__dirname, 'public', 'messageboard.html');
        res.sendFile(filePath, (err) => {
            if (err) {
                // This would be an internal error, e.g., file is missing.
                res.status(500).send('Error loading page.');
            }
        });
    });
});


app.get('/api/updates', (req, res) => {
    // Cap concurrent streams per client address: these connections are
    // unauthenticated, so one visitor must not be able to hold the box
    // hostage with thousands of open sockets.
    const ip = req.ip || 'unknown';
    const active = ssePerIp.get(ip) || 0;
    if (active >= MAX_SSE_PER_IP) {
        return res.status(503).json({ error: 'Too many open streams from your address' });
    }
    ssePerIp.set(ip, active + 1);
    let released = false;

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    // Listener for new messages
    const newMessageHandler = (data) => {
        res.write('event: newMessage\n');
        res.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    const newThreadHandler = (data) => {
        res.write('event: newThread\n');
        res.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    const threadArchivedHandler = (data) => {
        res.write('event: threadArchived\n');
        res.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    const graffitiHandler = (data) => {
       res.write('event: graffitiUpdate\n');
       res.write(`data: ${JSON.stringify(data)}\n\n`);
   };
   events.on('graffitiUpdate', graffitiHandler);

    // Keep-alive comment so proxies don't drop idle streams
    const heartbeat = setInterval(() => {
        if (!res.writableEnded) res.write(': ping\n\n');
    }, 30000);

    // Attach both listeners
    events.on('newMessage', newMessageHandler);
    events.on('newThread', newThreadHandler);
    events.on('threadArchived', threadArchivedHandler);

    // IMPORTANT: Remove all listeners when the client disconnects
    req.on('close', () => {
        clearInterval(heartbeat);
        events.removeListener('newMessage', newMessageHandler);
        events.removeListener('graffitiUpdate', graffitiHandler);
        events.removeListener('newThread', newThreadHandler);
        events.removeListener('threadArchived', threadArchivedHandler);
        if (!released) {
            released = true;
            const left = (ssePerIp.get(ip) || 1) - 1;
            if (left <= 0) ssePerIp.delete(ip); else ssePerIp.set(ip, left);
        }
    });
});

// --- Archiving Logic ---
function checkAndArchiveOldestThread() {
    db.get("SELECT COUNT(*) as count FROM threads WHERE isArchived = 0", [], (err, row) => {
        if (err) return console.error("Could not get thread count:", err.message);

        if (row.count > THREAD_LIMIT) {
            const sql = `SELECT id FROM threads WHERE isArchived = 0 ORDER BY lastBump ASC LIMIT 1`;
            db.get(sql, [], (err, thread) => {
                if (err) return console.error("Could not find oldest thread:", err.message);
                if (thread) {
                    db.run(`UPDATE threads SET isArchived = 1 WHERE id = ?`, [thread.id], function (err) {
                        if (err) return console.error(`Failed to archive thread ${thread.id}:`, err.message);
                        console.log(`Archived thread ${thread.id} due to thread limit.`);
                        events.emit('threadArchived', { threadId: thread.id });
                    });
                }
            });
        }
    });
}

app.get('/api/graffiti', (req, res) => {
    db.all('SELECT x, y, char, brightness, color FROM graffiti', [], (err, rows) => {
        if (err) return internalError(res, err);
        // Compact: [[x, y, char, brightness, color], ...] — ~5x smaller than
        // one JSON object per pixel on a full wall
        res.json(rows.map(r => [r.x, r.y, r.char, r.brightness, r.color]));
    });
});

// ---------------------------------------------------------------------------
// Graffiti realtime fanout — aggregated, size- and rate-bounded
// A big paste used to be JSON.stringified per pixel-array per SSE client,
// i.e. one free POST of up to 4 walls fanned out ~7MB * every open stream.
// Paints are now merged per cell and flushed as ONE frame per client every
// GRAFFITI_FANOUT_MS: repeated paste/erase storms cost downstream viewers
// at most 2 frames/sec, and a frame can never exceed the wall itself
// (WALL_WIDTH * WALL_HEIGHT cells) because the merge key is the cell.
// ---------------------------------------------------------------------------
const GRAFFITI_FANOUT_MS = 500;
const MAX_SSE_PER_IP = 20;
const ssePerIp = new Map();     // ip -> open stream count
const pendingPixels = new Map(); // "x,y" -> merged pixel (last write wins)
let fanoutTimer = null;

function queuePixelsForBroadcast(pixels) {
    for (const p of pixels) {
        pendingPixels.set(p.x + ',' + p.y, {
            x: p.x, y: p.y, char: p.char,
            brightness: 1, color: (p.color != null) ? p.color : 0
        });
    }
    if (!fanoutTimer) fanoutTimer = setTimeout(flushPixelFanout, GRAFFITI_FANOUT_MS);
}

function flushPixelFanout() {
    fanoutTimer = null;
    if (pendingPixels.size === 0) return;
    const frame = [...pendingPixels.values()]; // <= WALL_WIDTH * WALL_HEIGHT
    pendingPixels.clear();
    events.emit('graffitiUpdate', frame);
}

// POST new graffiti (Accepts a list of pixels/chars)
app.post('/api/graffiti', graffitiLimiter, async (req, res) => {
    const pixels = req.body.pixels; // Expects [{x, y, char, color}, ...]
    if (!pixels || !Array.isArray(pixels) || pixels.length === 0) return res.status(400).send('Invalid data');
    if (pixels.length > GRAFFITI_MAX_PIXELS) {
        return res.status(413).send(`Too many pixels in one request (max ${GRAFFITI_MAX_PIXELS})`);
    }

    // Validate every pixel before touching the DB (the client validates too,
    // but the HTTP endpoint is the trust boundary)
    for (const p of pixels) {
        const x = Number(p && p.x), y = Number(p && p.y);
        if (!Number.isInteger(x) || x < 0 || x >= WALL_WIDTH ||
            !Number.isInteger(y) || y < 0 || y >= WALL_HEIGHT) {
            return res.status(400).send('Pixel out of bounds');
        }
        const ch = (typeof p.char === 'string') ? p.char : '';
        if (ch.length < 1 || ch.length > 2) return res.status(400).send('Invalid char');
        // Reject invisible control characters (any code point in the cell,
        // incl. DEL/C1) — they store junk pixels that never render but
        // bloat the wall and every fanout frame.
        for (const c of ch) {
            const cp = c.codePointAt(0);
            if (cp < 32 || (cp >= 0x7f && cp <= 0x9f) || (cp >= 0x200b && cp <= 0x200f)) {
                return res.status(400).send('Invalid char');
            }
        }
        const ci = Number(p.color != null ? p.color : 0);
        // Valid: palette index 0-7, legacy blink 8, modern blink codes 800-877
        if (!Number.isInteger(ci) || (ci > 7 && ci !== 8 && (ci < 800 || ci > 877))) {
            return res.status(400).send('Invalid color index');
        }
    }

    // Collapse redraws of the same cell (typing/paste can hit one cell many
    // times per batch) — required for the multi-row upsert below, because a
    // single SQLite statement cannot affect the same row twice.
    const unique = [...new Map(pixels.map(p => [p.x + ',' + p.y, p])).values()];
    const timestamp = Date.now();

    try {
        await withTransaction(async () => {
            // Chunked multi-row upserts: bounded parameter list per statement,
            // real per-statement error reporting (the old prepared-statement
            // loop swallowed every row error), and far fewer round-trips.
            const CHUNK = 500;
            for (let i = 0; i < unique.length; i += CHUNK) {
                const rows = unique.slice(i, i + CHUNK);
                const placeholders = rows.map(() => '(?, ?, ?, 1.0, ?, ?)').join(', ');
                const params = rows.flatMap(p => [p.x, p.y, p.char, (p.color != null) ? p.color : 0, timestamp]);
                await dbAsync.run(
                    `INSERT INTO graffiti (x, y, char, brightness, color, timestamp) VALUES ${placeholders}
                     ON CONFLICT(x, y) DO UPDATE SET
                         char=excluded.char,
                         brightness=1.0,
                         color=excluded.color,
                         timestamp=excluded.timestamp`,
                    params
                );
            }
        });
    } catch (err) {
        console.error('Graffiti write failed:', err.message);
        return res.status(500).send('Database error');
    }

    // Aggregated real-time update (flushed within GRAFFITI_FANOUT_MS)
    queuePixelsForBroadcast(unique);
    res.json({ success: true });
});

// --- Decay Logic ---
setInterval(() => {
    console.log('Running Graffiti Decay...');
    // Formula: Brightness = Brightness * 0.7
    // We delete if brightness < 0.1 (roughly visible threshold)
    
    db.serialize(() => {
        // 1. Reduce brightness
        db.run(`UPDATE graffiti SET brightness = brightness * ?`, [DECAY_FACTOR], () => {
            // 2. Delete invisible characters, then tell open clients so their
            //    local wall mirrors the fade (they apply the same math)
            db.run(`DELETE FROM graffiti WHERE brightness < 0.1`, () => {
                events.emit('graffitiDecay', { factor: DECAY_FACTOR, threshold: 0.1 });
            });
        });
    });
}, DECAY_INTERVAL_MS);


app.get('/stream', (req, res) => {
    // The Icecast source (local by default); override with ICECAST_STREAM_URL
    // in .env if the source listens elsewhere on the VPN.
    const icecastUrl = process.env.ICECAST_STREAM_URL || 'http://127.0.0.1:8000/stream';

    const icecastRequest = http.get(icecastUrl, (icecastResponse) => {
        // Never forward Icecast's error bodies as if they were audio
        if (icecastResponse.statusCode >= 400) {
            icecastResponse.resume(); // drain
            console.error(`Icecast replied ${icecastResponse.statusCode}`);
            return res.status(502).json({ error: 'Stream unavailable' });
        }
        // Forward the headers from Icecast to the client
        // (this includes the important 'Content-Type: audio/mpeg')
        res.writeHead(icecastResponse.statusCode, icecastResponse.headers);
        icecastResponse.pipe(res);
        icecastResponse.on('error', () => res.destroy());
    });

    // Give up if Icecast accepts the connection but never answers
    icecastRequest.setTimeout(10000, () => icecastRequest.destroy(new Error('Icecast connect timeout')));

    // Handle potential errors, like if Icecast is down
    icecastRequest.on('error', (err) => {
        console.error('Error connecting to Icecast:', err.message);
        if (!res.headersSent) res.status(502).json({ error: 'Stream unavailable' });
        else res.destroy(); // half-sent stream: kill it, don't hang the client
    });

    // Listener disconnected (tab closed, player stopped) -> release the
    // upstream Icecast connection immediately instead of parking a dead
    // upstream socket until Icecast times it out.
    res.on('close', () => icecastRequest.destroy());
});

app.get('/radio', (req, res) => {
    const filePath = path.join(__dirname, 'public', `radio.html`);
    res.sendFile(filePath, (err) => {
        if (err) {
            res.status(404).send('Page not found.');
        }
    });
})

app.get('/admin', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

app.get('/wall', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'graffiti.html'));
});

// --- Necroweb: archived threads API (paginated, 20 per page, bump order) ---
app.get('/api/archived-threads', (req, res) => {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = 20;
    const offset = (page - 1) * limit;

    const countSql = 'SELECT COUNT(*) AS total FROM threads WHERE isArchived = 1';
    const listSql = `
        SELECT
            t.id AS threadId,
            t.messageCount,
            t.lastBump,
            m.text,
            m.signature,
            m.hash,
            m.mediaUrl,
            m.thumbnailUrl
        FROM threads t
        JOIN messages m ON t.id = m.threadId
        WHERE t.isArchived = 1 AND m.isHeadPost = 1
        ORDER BY t.lastBump DESC
        LIMIT ? OFFSET ?
    `;

    db.get(countSql, [], (err, row) => {
        if (err) {
            internalError(res, err);
            return;
        }
        const total = row.total;
        db.all(listSql, [limit, offset], (err, rows) => {
            if (err) {
                internalError(res, err);
                return;
            }
            res.json({
                threads: rows,
                page,
                totalPages: Math.ceil(total / limit),
                total
            });
        });
    });
});

app.get('/necroweb', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'necroweb.html'));
});

// ---------------------------------------------------------------------------
// JSON error handler — multer rejections (e.g. LIMIT_FILE_SIZE) and body-parser
// errors must answer with JSON, not Express's default HTML error page.
// ---------------------------------------------------------------------------
app.use((err, req, res, next) => {
    if (err instanceof multer.MulterError) {
        if (err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'File too large (max 20MB)' });
        return res.status(400).json({ error: err.message });
    }
    console.error('Unhandled error:', err && err.message);
    // body-parser errors carry expose/status; anything else stays internal
    const status = err.status || err.statusCode || 500;
    res.status(status).json({ error: status < 500 ? err.message : 'Internal server error' });
});

// ---------------------------------------------------------------------------
// Server startup
// ---------------------------------------------------------------------------

// Start the HTTP server
http.createServer(app).listen(port, () => {
    console.log(`Message Board running on port ${port}`);
});
