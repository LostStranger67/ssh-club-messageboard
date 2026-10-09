// .env is the single source of truth: override any inherited env vars
require('dotenv').config({ override: true });
const express = require('express');
const multer = require('multer');
const ffmpeg = require('fluent-ffmpeg');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const net = require('net');
const crypto = require('crypto');
const sqlite3 = require('sqlite3').verbose();
const rateLimit = require('express-rate-limit');

const app = express();
app.disable('x-powered-by');
// The radio backend is only ever reached through the main board's proxy (on
// 127.0.0.1), which forwards the real client IP. Trusting LOOPBACK peers only
// means X-Forwarded-For is honored from the proxy but can never be forged by
// a client — the old config let anyone spoof XFF and jump every per-IP limit.
app.set('trust proxy', 'loopback');

// License registry: canonical deed URLs are derived server-side from the
// license_type, so clients can never inject arbitrary "license" URLs.
const LICENSE_TYPES = {
    'CC-BY-4.0':       { label: 'CC BY 4.0',     url: 'https://creativecommons.org/licenses/by/4.0/' },
    'CC-BY-SA-4.0':    { label: 'CC BY-SA 4.0',  url: 'https://creativecommons.org/licenses/by-sa/4.0/' },
    'CC-BY-NC-4.0':    { label: 'CC BY-NC 4.0',  url: 'https://creativecommons.org/licenses/by-nc/4.0/' },
    'CC-BY-NC-SA-4.0': { label: 'CC BY-NC-SA 4.0', url: 'https://creativecommons.org/licenses/by-nc-sa/4.0/' },
    'CC0-1.0':         { label: 'CC0 1.0',       url: 'https://creativecommons.org/publicdomain/zero/1.0/' },
    'DIRECT_CONSENT':  { label: "Uploaded with owner's consent", url: null },
    // Older / less common deeds (backfilled from attributions.html, not offered in the upload form)
    'CC-BY-SA-3.0':    { label: 'CC BY-SA 3.0',  url: 'https://creativecommons.org/licenses/by-sa/3.0/' },
    'CC-BY-NC-SA-3.0': { label: 'CC BY-NC-SA 3.0', url: 'https://creativecommons.org/licenses/by-nc-sa/3.0/' },
    'CC-BY-NC-ND-3.0': { label: 'CC BY-NC-ND 3.0', url: 'https://creativecommons.org/licenses/by-nc-nd/3.0/' },
    'CC-BY-NC-ND-4.0': { label: 'CC BY-NC-ND 4.0', url: 'https://creativecommons.org/licenses/by-nc-nd/4.0/' },
    'SUNO_AI_FREE':    { label: 'Made with suno.ai (free plan)', url: 'https://suno.com/terms' },
};
const DEFAULT_SOURCE_URL = 'https://ssh-club.org/radio';

const apiLimiter = rateLimit({
    windowMs: 1 * 60 * 1000, // 1 minute
    limit: 10,
    message: 'Too many requests from this IP, please try again after a minute',
    standardHeaders: true, // Return rate limit info in the `RateLimit-*` headers
    legacyHeaders: false, // Disable the `X-RateLimit-*` headers
});

// Uploads cost the server an ffprobe + a full ffmpeg re-encode, so they get
// their own, tighter budget than song requests.
const uploadLimiter = rateLimit({
    windowMs: 1 * 60 * 1000,
    limit: 3,
    message: 'Too many uploads from this IP, please try again after a minute',
    standardHeaders: true,
    legacyHeaders: false,
});

// Apply the rate limiters to the expensive POST endpoints
app.use('/api/request', apiLimiter);
app.use('/api/upload', uploadLimiter);

// No default fallback: a password baked into the repo is a breach waiting for
// the next fresh deploy without a .env. Fail closed instead.
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
if (!ADMIN_PASSWORD) {
    console.error('FATAL: ADMIN_PASSWORD is not set (radio/.env). Refusing to start with a default admin password.');
    process.exit(1);
}
const TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000; // tokens live one week
const adminTokens = new Map(); // token -> expiry (epoch ms), in-memory

// Constant-time string comparison for passwords
function safeEqual(a, b) {
    const ab = Buffer.from(String(a));
    const bb = Buffer.from(String(b));
    if (ab.length !== bb.length) {
        crypto.timingSafeEqual(ab, ab); // keep timing uniform
        return false;
    }
    return crypto.timingSafeEqual(ab, bb);
}

function issueAdminToken() {
    const token = crypto.randomBytes(32).toString('hex');
    adminTokens.set(token, Date.now() + TOKEN_TTL_MS);
    return token;
}

function isValidAdminToken(token) {
    const expiry = adminTokens.get(token);
    if (!expiry) return false;
    if (expiry <= Date.now()) {
        adminTokens.delete(token);
        return false;
    }
    return true;
}

// Periodically sweep expired tokens
setInterval(() => {
    const now = Date.now();
    for (const [token, expiry] of adminTokens) {
        if (expiry <= now) adminTokens.delete(token);
    }
}, 60 * 60 * 1000).unref();

// Brute-force protection for the login endpoint
const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    limit: 5, // 5 attempts per IP per window
    standardHeaders: true,
    legacyHeaders: false,
});

function requireAdmin(req, res, next) {
    const auth = req.headers.authorization;
    if (!auth || !auth.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    const token = auth.slice('Bearer '.length).trim();
    // Session tokens ONLY. The old "legacy" path accepted the raw admin
    // password as the bearer token, which meant the actual password had to
    // circulate in browser storage and request headers forever.
    if (isValidAdminToken(token)) {
        return next();
    }
    res.status(401).json({ error: 'Unauthorized' });
}

// ---------------------------------------------------------------------------
// Command execution — NO shell, ever.
// These paths used to interpolate user-controlled strings (artist/title in
// filenames came from ANONYMOUS uploads) into shell command lines for exec(),
// so `$(...)` / backticks executed on this server (pre-auth RCE via upload,
// and again on every later admin edit of the poisoned filename).
// run() spawns a binary with an explicit argv array: arguments are data,
// never shell syntax. For ssh, the command STRING is only interpreted by the
// REMOTE shell, so each value embedded in it is quoted with shq().
// ---------------------------------------------------------------------------
function run(argv, opts = {}) {
    return new Promise((resolve, reject) => {
        const [cmd, ...args] = argv;
        const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], ...opts });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', d => stdout += d);
        child.stderr.on('data', d => stderr += d);
        child.on('error', reject);
        child.on('close', code => code === 0
            ? resolve(stdout)
            : reject(new Error(`${cmd} exited ${code}: ${stderr.slice(0, 300)}`)));
    });
}

// POSIX single-quote an argument for the REMOTE shell
const shq = s => `'${String(s).replace(/'/g, `'\\''`)}'`;

// Internal failures log the detail, clients only ever see a generic message.
function internalError(res, err) {
    console.error('Internal error:', err && err.message);
    return res.status(500).json({ error: 'Internal server error' });
}


/**
 * Update ID3 tags of an MP3 file on Oracle
 * @param {string} filename - The exact filename on Oracle (e.g., "Artist - Title.mp3")
 * @param {string} artist - New artist
 * @param {string} title - New title
 * @returns {Promise<string>} - stdout from the remote command
 */
async function updateId3TagsOnOracle(filename, artist, title) {
    const target = ORACLE_MUSIC_PATH + filename;
    const temp = ORACLE_MUSIC_PATH + 'temp_' + filename;
    // One argument handed to ssh (no local shell at all); every embedded path
    // and metadata value is quoted for the remote shell with shq().
    const remoteCmd =
        `ffmpeg -y -i ${shq(target)} -c copy -map_metadata -1 ` +
        `-metadata artist=${shq(artist)} -metadata title=${shq(title)} ${shq(temp)} ` +
        `&& mv ${shq(temp)} ${shq(target)}`;
    return run(['ssh', 'oracle-proxy', remoteCmd]);
}

const PORT = process.env.PORT || 3456;

// Oracle VPN details — the private-network address is deployment config, not
// source code (lives in the untracked radio/.env)
const ORACLE_VPN_IP = process.env.ORACLE_VPN_IP;
if (!ORACLE_VPN_IP) {
    console.error('FATAL: ORACLE_VPN_IP is not set (radio/.env).');
    process.exit(1);
}
const ORACLE_TELNET_PORT = 1234;
const ORACLE_MUSIC_PATH = '/home/ubuntu/radio/music/';

// Local paths
const UPLOAD_DIR = path.join(__dirname, 'uploads');
const NORMALIZED_DIR = path.join(__dirname, 'normalized');

// Ensure directories exist
[UPLOAD_DIR, NORMALIZED_DIR].forEach(dir => {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

// SQLite database setup
const db = new sqlite3.Database('./catalog.db');

db.serialize(() => {
    db.run(`
        CREATE TABLE IF NOT EXISTS songs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            filename TEXT UNIQUE NOT NULL,
            source TEXT NOT NULL DEFAULT 'uploaded' CHECK(source IN ('original', 'uploaded')),
            uploaded_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            request_count INTEGER DEFAULT 0,
            last_requested_at DATETIME,
            file_size INTEGER,
            duration_seconds INTEGER,
            artist TEXT,
            title TEXT,
            license_type TEXT,
            license_url TEXT,
            source_url TEXT
        )
    `);

    // News ticker entries (rendered as a marquee on the graffiti wall)
    db.run(`
        CREATE TABLE IF NOT EXISTS news (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            text TEXT NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);

    // The law docket (public list + admin management)
    db.run(`
        CREATE TABLE IF NOT EXISTS docket (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            text TEXT NOT NULL,
            status TEXT NOT NULL CHECK(status IN ('legalized', 'criminalized')),
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);
});

// Migration: add artist/title columns for databases created before they existed
db.all('PRAGMA table_info(songs)', [], (err, columns) => {
    if (err) return console.error('Pragma error:', err);
    const cols = columns.map(c => c.name);
    if (!cols.includes('artist')) db.run('ALTER TABLE songs ADD COLUMN artist TEXT');
    if (!cols.includes('title')) db.run('ALTER TABLE songs ADD COLUMN title TEXT');
    // License columns are SELECTed/INSERTed unconditionally — without these a
    // freshly initialized catalog 500s on /api/songs and silently drops
    // upload inserts.
    if (!cols.includes('license_type')) db.run('ALTER TABLE songs ADD COLUMN license_type TEXT');
    if (!cols.includes('license_url')) db.run('ALTER TABLE songs ADD COLUMN license_url TEXT');
    if (!cols.includes('source_url')) db.run('ALTER TABLE songs ADD COLUMN source_url TEXT');
});

// Multer setup (20MB cap — same as the main board; prevents disk-fill via the public upload)
const upload = multer({ dest: UPLOAD_DIR, limits: { fileSize: 20 * 1024 * 1024 } });

// Basic HTTP security headers (applied to every response; placed before
// express.static so static files get them too). Deliberately no
// X-Frame-Options / frame-ancestors: the player is embedded cross-origin
// in an iframe on purpose.
app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    // Everything same-origin; pages use inline <script> so 'unsafe-inline'
    // stays until those move into files.
    res.setHeader('Content-Security-Policy',
        "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; " +
        "img-src 'self' data: blob:; media-src 'self' blob: https://ssh-club.org; font-src 'self'; " +
        "connect-src 'self' https://ssh-club.org; base-uri 'self'; form-action 'self'; object-src 'none'");
    next();
});

app.use(express.static('public'));
app.use(express.json());

// Helper: promisify exec

// Helper: Telnet queue request
function queueSongOnOracle(songPath) {
    return new Promise((resolve, reject) => {
        const client = net.createConnection({ host: ORACLE_VPN_IP, port: ORACLE_TELNET_PORT }, () => {
            client.write(`user_requests.push ${songPath}\n`);
        });

        let data = '';
        let timeoutHandle = setTimeout(() => {
            client.destroy();
            reject(new Error('Telnet timeout'));
        }, 5000);

        client.on('data', chunk => {
            data += chunk.toString();
            if (data.includes('END')) {
                clearTimeout(timeoutHandle);
                client.end();
                resolve(data.trim());
            }
        });

        client.on('error', err => {
            clearTimeout(timeoutHandle);
            reject(err);
        });

        client.on('close', () => {
            if (!data.includes('END')) {
                clearTimeout(timeoutHandle);
                reject(new Error('Connection closed prematurely'));
            }
        });
    });
}

// Helper: Copy file to Oracle via scp
function copyToOracle(localFilePath, remoteFilename) {
    // argv array — the remote filename is data, never shell syntax
    return run(['scp', '-o', 'StrictHostKeyChecking=no', localFilePath, `oracle-proxy:${ORACLE_MUSIC_PATH}${remoteFilename}`]);
}

// Admin login: exchange password for a short-lived session token
app.post('/api/admin/login', loginLimiter, (req, res) => {
    const { password } = req.body || {};
    if (typeof password !== 'string' || !safeEqual(password, ADMIN_PASSWORD)) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    const token = issueAdminToken();
    res.json({ token, expiresInMs: TOKEN_TTL_MS });
});

// admin stuff
app.get('/api/admin/songs', requireAdmin, (req, res) => {
    db.all('SELECT * FROM songs ORDER BY uploaded_at DESC', [], (err, rows) => {
        if (err) return internalError(res, err);
        res.json({ songs: rows });
    });
});

// Delete a song (from DB and Oracle)
// Delete a song (move to deleted folder, remove from DB)
app.delete('/api/admin/songs/:id', requireAdmin, async (req, res) => {
    const id = parseInt(req.params.id, 10);

    db.get('SELECT filename FROM songs WHERE id = ?', [id], async (err, row) => {
        if (err) return internalError(res, err);
        if (!row) return res.status(404).json({ error: 'Song not found' });

        const filename = row.filename;
        const musicPath = `/home/ubuntu/radio/music/${filename}`;
        const deletedPath = `/home/ubuntu/radio/deleted/${filename}`;

        // Move file to deleted folder on Oracle (no local shell; shq protects
        // both paths on the REMOTE side)
        run(['ssh', 'oracle-proxy', `mv ${shq(musicPath)} ${shq(deletedPath)}`]).then(() => {
            // Remove from local DB
            db.run('DELETE FROM songs WHERE id = ?', [id], (delErr) => {
                if (delErr) {
                    console.error('DB delete error:', delErr);
                    return res.status(500).json({ error: 'File moved but DB delete failed' });
                }
                res.json({ status: 'moved_to_deleted', filename: filename });
            });
        }).catch((moveErr) => {
            console.error('Move error:', moveErr);
            res.status(500).json({ error: 'Failed to move file to deleted folder' });
        });
    });
});

// Edit song metadata
app.patch('/api/admin/songs/:id', requireAdmin, (req, res) => {
    const id = parseInt(req.params.id, 10);
    const { artist, title } = req.body;

    if (!artist || !title) {
        return res.status(400).json({ error: 'Artist and title required' });
    }

    // First, get the current filename
    db.get('SELECT filename FROM songs WHERE id = ?', [id], async (err, row) => {
        if (err) return internalError(res, err);
        if (!row) return res.status(404).json({ error: 'Song not found' });

        // Update database
        db.run(
            'UPDATE songs SET artist = ?, title = ? WHERE id = ?',
            [artist, title, id],
            async (dbErr) => {
                if (dbErr) return res.status(500).json({ error: dbErr.message });

                // Sync ID3 tags on Oracle (fire and forget – we can await but not critical for response)
                updateId3TagsOnOracle(row.filename, artist, title)
                    .then(() => console.log(`ID3 updated for ${row.filename}`))
                    .catch(e => console.error(`ID3 sync failed for ${row.filename}:`, e));

                res.json({ status: 'updated', artist, title });
            }
        );
    });
});

// Admin upload to jingles folder
const jingleUpload = multer({ dest: UPLOAD_DIR, limits: { fileSize: 20 * 1024 * 1024 } }); // reuse same temp dir

app.post('/api/admin/jingles', requireAdmin, jingleUpload.single('jingle'), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    const originalPath = req.file.path;
    const originalName = req.file.originalname;

    // Sanitize filename (allow spaces, hyphens, underscores, alphanumeric)
    const safeName = originalName
        .replace(/[^a-zA-Z0-9\.\-_ ]/g, '')
        .trim()
        .replace(/\s+/g, ' ');

    if (!safeName) {
        fs.unlinkSync(originalPath);
        return res.status(400).json({ error: 'Invalid filename' });
    }

    // Add timestamp suffix to avoid collisions; the normalized output is mp3
    // no matter what the original file was called, so force that extension.
    const uniqueSuffix = Date.now() + '-' + Math.random().toString(36).substring(2, 8);
    const base = path.basename(safeName, path.extname(safeName));
    const finalFilename = `${base}__${uniqueSuffix}.mp3`;

    try {
        // Normalize with ffmpeg (optional but recommended to ensure compatibility)
        const normalizedPath = path.join(NORMALIZED_DIR, finalFilename);
        await new Promise((resolve, reject) => {
            ffmpeg(originalPath)
                .audioBitrate(128)
                .audioFrequency(44100)
                .audioChannels(2)
                .format('mp3')
                .outputOptions('-threads', '1')
                .on('end', resolve)
                .on('error', reject)
                .save(normalizedPath);
        });

        fs.unlinkSync(originalPath);

        // Copy to Oracle jingles folder
        await run(['scp', '-o', 'StrictHostKeyChecking=no',
            normalizedPath, `oracle-proxy:/home/ubuntu/radio/jingles/${finalFilename}`]);

        // Optionally delete local normalized file
        fs.unlinkSync(normalizedPath);

        res.json({ status: 'uploaded', filename: finalFilename });
    } catch (err) {
        console.error('Jingle upload error:', err);
        if (fs.existsSync(originalPath)) fs.unlinkSync(originalPath);
        if (fs.existsSync(normalizedPath)) fs.unlinkSync(normalizedPath);
        internalError(res, err);
    }
});

// API: Get all songs with optional search
app.get('/api/songs', (req, res) => {
    const search = req.query.q || '';
    const query = search
        ? `SELECT id, artist, title, source, uploaded_at, request_count, license_type, license_url, source_url
           FROM songs WHERE artist LIKE ? OR title LIKE ? OR filename LIKE ?
           ORDER BY source DESC, uploaded_at DESC`
        : `SELECT id, artist, title, source, uploaded_at, request_count, license_type, license_url, source_url
           FROM songs ORDER BY source DESC, uploaded_at DESC`;
    const params = search ? [`%${search}%`, `%${search}%`, `%${search}%`] : [];

    db.all(query, params, (err, rows) => {
        if (err) return internalError(res, err);
        // Ensure fallback for rows missing artist/title
        rows = rows.map(row => ({
            ...row,
            artist: row.artist || 'Unknown',
            title: row.title || row.filename?.replace(/\.mp3$/i, '') || 'Untitled',
            source_url: row.source_url || DEFAULT_SOURCE_URL
        }));
        res.json({ songs: rows });
    });
});

// API: Request a song
app.post('/api/request', async (req, res) => {
    const { songId } = req.body;
    if (!songId) return res.status(400).json({ error: 'No song ID specified' });

    db.get('SELECT filename FROM songs WHERE id = ?', [songId], async (err, row) => {
        if (err) return internalError(res, err);
        if (!row) return res.status(404).json({ error: 'Song not found' });

        // Increment request count
        db.run('UPDATE songs SET request_count = request_count + 1, last_requested_at = CURRENT_TIMESTAMP WHERE id = ?', [songId]);

        try {
            const fullPath = ORACLE_MUSIC_PATH + row.filename;
            const response = await queueSongOnOracle(fullPath);
            res.json({ status: 'queued', response });
        } catch (err) {
            console.error('Queue error:', err);
            res.status(500).json({ error: 'Failed to queue song' });
        }
    });
});

// Validate audio file before processing (ffprobe via argv — no shell)
async function validateAudioFile(filePath) {
    let stdout;
    try {
        stdout = await run(['ffprobe', '-v', 'quiet', '-print_format', 'json',
            '-show_format', '-show_streams', filePath]);
    } catch (err) {
        throw new Error(`File is not valid audio: ${err.message}`);
    }

    let metadata;
    try {
        metadata = JSON.parse(stdout);
    } catch (parseError) {
        throw new Error(`Failed to parse audio metadata: ${parseError.message}`);
    }

    const audioStream = (metadata.streams || []).find(s => s.codec_type === 'audio');
    if (!audioStream) {
        throw new Error('No audio stream found in file.');
    }

    const duration = parseFloat(metadata.format && metadata.format.duration);
    // NaN-safe: a stream with no reported duration must be REJECTED (the old
    // `duration < 5 || duration > 600` check let NaN through both ways).
    if (!(duration >= 5 && duration <= 600)) {
        throw new Error(`Invalid duration: ${duration}s. Must be between 5s and 600s.`);
    }

    return { valid: true, duration };
}


// API: Upload new song
app.post('/api/upload', upload.single('track'), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    const { artist, title, licenseType, sourceUrl } = req.body;
    // Defense-in-depth: strip path separators, ALL shell metacharacters
    // (` $ ; & | < > ( ) { } [ ] ! ~ # ' " and quotes), and every control
    // character. Commands are built as argv arrays (see run()), so this is
    // belt — but a filename that survives here can never be syntax anywhere.
    const sanitize = (str) => String(str || '')
        .replace(/[\p{C}/\\:*?"'`<>|;$&`(){}\[\]!~#+%=]/gu, '')
        .trim()
        .replace(/\s+/g, ' ');
    const safeArtist = sanitize(artist);
    const safeTitle = sanitize(title);
    if (!safeArtist || !safeTitle) {
        fs.unlinkSync(req.file.path);
        return res.status(400).json({ error: 'Artist and title cannot be empty' });
    }
    // License is required: must be one of the known types
    const license = LICENSE_TYPES[licenseType];
    if (!license) {
        fs.unlinkSync(req.file.path);
        return res.status(400).json({ error: 'A valid license is required. Allowed: ' + Object.keys(LICENSE_TYPES).join(', ') });
    }
    // source_url: optional, must be http(s) — falls back to the radio itself
    let safeSourceUrl = DEFAULT_SOURCE_URL;
    const rawSourceUrl = String(sourceUrl || '').trim();
    if (rawSourceUrl) {
        try {
            const u = new URL(rawSourceUrl);
            if (u.protocol === 'http:' || u.protocol === 'https:') safeSourceUrl = u.href;
        } catch {
            // not a URL — keep the default
        }
    }
    const uniqueSuffix = Date.now() + '-' + Math.random().toString(36).substring(2, 8);
    const normalizedFilename = `${safeArtist} - ${safeTitle}__${uniqueSuffix}.mp3`;
    const originalPath = req.file.path;
    const normalizedPath = path.join(NORMALIZED_DIR, normalizedFilename);

    try {
        const { duration } = await validateAudioFile(originalPath);
        // Normalize with ffmpeg

        await new Promise((resolve, reject) => {
            ffmpeg(originalPath)
                .audioBitrate(128)
                .audioFrequency(44100)
                .audioChannels(2)
                .format('mp3')
                // NOTE: pass options as separate arguments, not as an array.
                // fluent-ffmpeg splits array elements on spaces, which would
                // break values containing spaces (e.g. artist "Ben Fero").
                .outputOptions(
                    '-map_metadata', '-1',
                    '-metadata', `title=${safeTitle}`,
                    '-metadata', `artist=${safeArtist}`,
                    '-metadata', 'album=DoNotEn.tr',
                    '-threads', '1'
                )
                .on('end', resolve)
                .on('error', reject)
                .save(normalizedPath);
        });


        fs.unlinkSync(originalPath);

        // Copy to Oracle
        await copyToOracle(normalizedPath, normalizedFilename);
        console.log(`Copied ${normalizedFilename} to Oracle`);

        // Add to database — a catalog insert failure must reach the client
        // (files are already on Oracle; the admin sees the error and can act)
        db.run(
            `INSERT INTO songs (filename, source, artist, title, uploaded_at, request_count, license_type, license_url, source_url)
         VALUES (?, 'uploaded', ?, ?, CURRENT_TIMESTAMP, 0, ?, ?, ?)`,
            [normalizedFilename, safeArtist, safeTitle, licenseType, license.url, safeSourceUrl],
            function (err) {
                if (err) {
                    console.error('DB insert error:', err);
                    return res.status(500).json({ error: 'File was stored, but the catalog insert failed. Tell the radio DJ.' });
                }
                // Not queued automatically — listeners can request it via /api/request.
                res.json({
                    status: 'uploaded',
                    filename: normalizedFilename
                });
            }
        );
    } catch (err) {
        console.error('Upload error:', err);
        if (fs.existsSync(originalPath)) fs.unlinkSync(originalPath);
        if (fs.existsSync(normalizedPath)) fs.unlinkSync(normalizedPath);
        internalError(res, err);
    }
});

// Public: get all laws
app.get('/api/docket', (req, res) => {
    db.all('SELECT * FROM docket ORDER BY created_at DESC', [], (err, rows) => {
        if (err) return internalError(res, err);
        res.json({ laws: rows });
    });
});

// Admin: add law
app.post('/api/admin/docket', requireAdmin, (req, res) => {
    const { text, status } = req.body;
    if (!text || !status || !['legalized', 'criminalized'].includes(status)) {
        return res.status(400).json({ error: 'Invalid law or status' });
    }
    db.run('INSERT INTO docket (text, status) VALUES (?, ?)', [text, status], function (err) {
        if (err) return internalError(res, err);
        res.json({ id: this.lastID, text, status });
    });
});

// Public: get all news ticker entries
app.get('/api/news', (req, res) => {
    db.all('SELECT * FROM news ORDER BY created_at DESC', [], (err, rows) => {
        if (err) return internalError(res, err);
        res.json({ news: rows });
    });
});

// Admin: add news entry
app.post('/api/admin/news', requireAdmin, (req, res) => {
    const text = String(req.body.text || '').trim();
    if (!text) return res.status(400).json({ error: 'News text cannot be empty' });
    db.run('INSERT INTO news (text) VALUES (?)', [text], function (err) {
        if (err) return internalError(res, err);
        res.json({ id: this.lastID, text });
    });
});

// Admin: delete news entry
app.delete('/api/admin/news/:id', requireAdmin, (req, res) => {
    const id = parseInt(req.params.id, 10);
    db.run('DELETE FROM news WHERE id = ?', [id], function (err) {
        if (err) return internalError(res, err);
        res.json({ deleted: id });
    });
});

// Admin: toggle status
app.patch('/api/admin/docket/:id', requireAdmin, (req, res) => {
    const id = parseInt(req.params.id, 10);
    const { status } = req.body;
    if (!status || !['legalized', 'criminalized'].includes(status)) {
        return res.status(400).json({ error: 'Invalid status' });
    }
    db.run('UPDATE docket SET status = ? WHERE id = ?', [status, id], function (err) {
        if (err) return internalError(res, err);
        res.json({ status: 'updated' });
    });
});

// Admin: delete law
app.delete('/api/admin/docket/:id', requireAdmin, (req, res) => {
    const id = parseInt(req.params.id, 10);
    db.run('DELETE FROM docket WHERE id = ?', [id], function (err) {
        if (err) return internalError(res, err);
        res.json({ status: 'deleted' });
    });
});

// API: Now playing (proxy Icecast)
// Cached for 10s: every listener polls this every 15s, so without a cache
// the external status URL is hammered by N_clients / 15s.
const NP_CACHE_MS = 10 * 1000;
let npCache = { at: 0, payload: null };
app.get('/api/now-playing', async (req, res) => {
    const now = Date.now();
    if (npCache.payload && now - npCache.at < NP_CACHE_MS) {
        return res.json(npCache.payload);
    }
    try {
        const response = await fetch('https://ssh-club.org/status-json.xsl', { signal: AbortSignal.timeout(5000) });
        const data = await response.json();
        const source = data.icestats?.source;
        let payload;
        if (source && typeof source === 'object' && !Array.isArray(source)) {
            payload = {
                rawTitle: source.title || 'Stream offline',
                listeners: source.listeners || 0
            };
        } else {
            payload = { title: 'Stream offline', artist: '', listeners: 0 };
        }
        npCache = { at: now, payload };
        res.json(payload);
    } catch (e) {
        // Don't cache errors so recovery is immediate
        res.json({ title: 'Error fetching', artist: '', listeners: 0 });
    }
});

// JSON error handler: multer rejections (e.g. LIMIT_FILE_SIZE) must not
// fall through to a bare 500 HTML page
app.use((err, req, res, next) => {
    if (!err) return next();
    if (err instanceof multer.MulterError) {
        if (err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'File too large (max 20MB)' });
        return res.status(400).json({ error: err.message });
    }
    console.error('Unhandled error:', err.message);
    internalError(res, err);
});

// Bind to loopback ONLY: this service is reached through the main board's
// /radio/api proxy; exposing it (and its admin UI) directly to the world was
// pure extra attack surface.
app.listen(PORT, '127.0.0.1', () => {
    console.log(`DoNotEn.tr radio backend on 127.0.0.1:${PORT}`);
});
