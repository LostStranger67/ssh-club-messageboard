-- In database/schema.sql

-- Use PRAGMA to enforce foreign key constraints
PRAGMA foreign_keys = ON;

-- Create the 'threads' table first because 'messages' depends on it
CREATE TABLE IF NOT EXISTS threads (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    -- Removed subject since the head post contains the text
    createdAt TEXT NOT NULL,
    lastBump TEXT NOT NULL,
    messageCount INTEGER NOT NULL DEFAULT 0,
    isArchived BOOLEAN NOT NULL DEFAULT 0 -- 0 for false, 1 for true
);

-- Create the 'messages' table
CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    threadId INTEGER NOT NULL,
    text TEXT NOT NULL,
    signature TEXT NOT NULL,
    hash TEXT, -- This is for the tripcode, can be NULL
    mediaUrl TEXT,
    thumbnailUrl TEXT,
    timestamp TEXT NOT NULL,
    isHeadPost BOOLEAN NOT NULL DEFAULT 0, -- 1 if it's the first post of a thread
    FOREIGN KEY (threadId) REFERENCES threads (id) ON DELETE CASCADE
);

-- Create indexes to speed up common queries
CREATE INDEX IF NOT EXISTS idx_messages_threadId ON messages (threadId);
CREATE INDEX IF NOT EXISTS idx_threads_lastBump ON threads (lastBump);