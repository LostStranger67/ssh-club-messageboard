#! node
// Admin deletion helper — run from anywhere:
//   node helper_scripts/admin_delete.js post <POST_ID>
//   node helper_scripts/admin_delete.js thread <THREAD_ID>
//   node helper_scripts/admin_delete.js tripcode <HASH>
//
// Media files of removed posts are deliberately NOT deleted: deleted-user
// content stays available for the board owner's audit decision (and the HTTP
// delete endpoint already moved anything user-deleted into
// deleted-user-content/). This CLI only clears database rows.

const db = require('../database/database.js');

const mode = process.argv[2];
const value = process.argv[3];

if (!mode || !value) {
    console.log('Usage:');
    console.log('  node helper_scripts/admin_delete.js post <POST_ID>');
    console.log('  node helper_scripts/admin_delete.js thread <THREAD_ID>');
    console.log('  node helper_scripts/admin_delete.js tripcode <HASH>');
    process.exit(1);
}

const report = (label) => function (err) {
    if (err) {
        console.error(`Error: ${err.message}`);
        process.exitCode = 1;
        return;
    }
    console.log(`${label} — ${this && this.changes != null ? this.changes : '?'} row(s) affected.`);
    db.close();
};

if (mode === 'post') {
    db.run('DELETE FROM messages WHERE id = ?', [parseInt(value, 10)], report(`Post ${value} deleted`));
} else if (mode === 'thread') {
    const threadId = parseInt(value, 10);
    // explicit cleanup — does not depend on ON DELETE CASCADE / foreign_keys pragma
    db.run('DELETE FROM messages WHERE threadId = ?', [threadId], (err) => {
        if (err) { console.error(`Error: ${err.message}`); process.exitCode = 1; return; }
        db.run('DELETE FROM threads WHERE id = ?', [threadId], report(`Thread #${threadId} deleted (with its messages)`));
    });
} else if (mode === 'tripcode') {
    db.run('DELETE FROM messages WHERE hash = ?', [value], report(`Messages for ${value} deleted`));
} else {
    console.error(`Unknown mode "${mode}" (use post|thread|tripcode)`);
    process.exit(1);
}
