# SSH Club Message Board
an underground messageboard for those who want to hang out

A lightweight anonymous imageboard-like system built with Node.js and SQLite.

## Features
- Threaded discussions
- Media upload (images, video, audio)
- Tripcode-style identity
- Real-time updates via Server-Sent Events
- Graffiti wall (300x150 shared ASCII canvas with decay + blink)
- DoNotEn.tr radio backend (requests, uploads, license registry)

## Setup
```bash
npm install
cp .env.example .env   # set HASH_SALT
npm start              # tables are created automatically on first run
```

The radio backend runs as its own service (`cd radio`, set
`ADMIN_PASSWORD` — it refuses to start without one). Deployment files
(systemd units, nginx config) are machine configuration and deliberately
not part of this repo.

## Admin tools
- `node helper_scripts/admin_delete.js post|thread|tripcode <id>`
- `python3 helper_scripts/messageboard_tool.py --help`
