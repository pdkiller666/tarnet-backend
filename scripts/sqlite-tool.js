#!/usr/bin/env node
// SQLite helper for TarNet/OpenClaw backups, using the built-in node:sqlite
// module (the sqlite3 CLI is not installed in this container).
//
//   sqlite-tool.js snapshot <source.db> <dest.db>   consistent copy (VACUUM INTO)
//   sqlite-tool.js verify   <db>                    PRAGMA integrity_check + counts
//   sqlite-tool.js restore  <dump.db> <target.db>   restore copy, then verify it
//
// All subcommands print a single JSON object on stdout and exit non-zero on failure.
'use strict';

const { DatabaseSync } = require('node:sqlite');
const { existsSync, statSync, rmSync } = require('node:fs');

function out(o) {
  process.stdout.write(JSON.stringify(o) + '\n');
}
function die(msg) {
  out({ ok: false, error: msg });
  process.exit(1);
}

// VACUUM INTO needs the destination as a single-quoted SQL literal: SQLite reads
// double quotes as identifiers, so JSON.stringify() produces an invalid statement.
function sqlLiteral(s) {
  return "'" + String(s).replace(/'/g, "''") + "'";
}

function integrity(file) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const row = db.prepare('PRAGMA integrity_check').get();
    const result = Object.values(row)[0];
    const tables = db
      .prepare("SELECT count(*) AS c FROM sqlite_master WHERE type = 'table'")
      .get().c;
    // Row census proves the dump carries data, not just an empty schema.
    // Table names here are the real ones; there is no `sessions` table.
    let rows = 0;
    for (const { name } of db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()) {
      try {
        rows += db.prepare(`SELECT count(*) AS c FROM "${name}"`).get().c;
      } catch {
        /* skip views/virtual tables that cannot be counted */
      }
    }
    return { result, tables, rows };
  } finally {
    db.close();
  }
}

const [cmd, a, b] = process.argv.slice(2);

try {
  if (cmd === 'snapshot') {
    if (!a || !b) die('usage: snapshot <source> <dest>');
    if (!existsSync(a)) die('source missing: ' + a);
    if (existsSync(b)) rmSync(b);
    const db = new DatabaseSync(a, { readOnly: true });
    db.exec('VACUUM INTO ' + sqlLiteral(b));
    db.close();
    if (!existsSync(b) || statSync(b).size === 0) die('snapshot produced no data');
    const v = integrity(b);
    out({ ok: v.result === 'ok', path: b, size: statSync(b).size, ...v });
  } else if (cmd === 'verify') {
    if (!a) die('usage: verify <db>');
    if (!existsSync(a)) die('file missing: ' + a);
    const v = integrity(a);
    out({ ok: v.result === 'ok', path: a, size: statSync(a).size, ...v });
  } else if (cmd === 'restore') {
    // Proves the dump is restorable: copy it to a fresh path and verify the copy.
    if (!a || !b) die('usage: restore <dump> <target>');
    if (!existsSync(a)) die('dump missing: ' + a);
    if (existsSync(b)) rmSync(b);
    const src = new DatabaseSync(a, { readOnly: true });
    src.exec('VACUUM INTO ' + sqlLiteral(b));
    src.close();
    const v = integrity(b);
    out({ ok: v.result === 'ok', path: b, size: statSync(b).size, ...v });
  } else {
    die('unknown command: ' + cmd);
  }
} catch (e) {
  die(e.message);
}
