// In database/database.js

const sqlite3 = require('sqlite3').verbose();
const path = require('path');

// Define the path to the database file
const dbPath = path.join(__dirname, '..', 'messageboard.db');

// Create a new database instance.
// The file 'messageboard.db' will be created in your project's root directory.
const db = new sqlite3.Database(dbPath, (err) => {
    if (err) {
        console.error('Error opening database', err.message);
    } else {
        console.log('Connected to the SQLite database.');
    }
});

// Export the database object
module.exports = db;