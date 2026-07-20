const { DatabaseSync } = require('node:sqlite');
const bcrypt = require('bcryptjs');
require('dotenv').config();

const DB_PATH = process.env.DB_PATH || './AV_fleetOS.db';
const db = new DatabaseSync(DB_PATH);

// Performance settings
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');

// ── Schema ──────────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    username    TEXT    NOT NULL UNIQUE,
    password    TEXT    NOT NULL,
    name        TEXT    NOT NULL,
    role        TEXT    NOT NULL DEFAULT 'manager',
    active      INTEGER NOT NULL DEFAULT 1,
    created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS bookings (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    vehicle_id  INTEGER NOT NULL,
    status      TEXT    NOT NULL DEFAULT 'reserved',
    start_date  TEXT    NOT NULL,
    end_date    TEXT    NOT NULL,
    data        TEXT    NOT NULL DEFAULT '{}',
    created_by  INTEGER,
    created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
    updated_at  TEXT    NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS vehicles (
    id           INTEGER PRIMARY KEY,
    service_data TEXT    NOT NULL DEFAULT '{}'
  );

  CREATE TABLE IF NOT EXISTS stickers (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    data       TEXT    NOT NULL DEFAULT '{}',
    created_at TEXT    NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS settings (
    key        TEXT    PRIMARY KEY,
    value      TEXT    NOT NULL,
    updated_at TEXT    NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS documents (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    vehicle_id    INTEGER NOT NULL,
    doc_type      TEXT    NOT NULL,
    filename      TEXT    NOT NULL,
    original_name TEXT    NOT NULL,
    mime_type     TEXT    NOT NULL,
    size          INTEGER NOT NULL,
    uploaded_by   INTEGER,
    created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS spare_parts (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    name          TEXT    NOT NULL,
    part_number   TEXT,
    quantity      REAL    NOT NULL DEFAULT 0,
    price         REAL    NOT NULL DEFAULT 0,
    supplier      TEXT,
    created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
    updated_at    TEXT    NOT NULL DEFAULT (datetime('now'))
  );
`);

// ── Migrations for pre-existing tables from earlier schema versions ──────
// (CREATE TABLE IF NOT EXISTS is a no-op if the table already exists under
// an older shape, so any columns added later need an explicit ALTER here.)
function ensureColumn(table, column, definition) {
  try {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  } catch (e) {
    if (!/duplicate column name/i.test(e.message || '')) throw e;
  }
}
ensureColumn('documents', 'uploaded_by', 'INTEGER');
ensureColumn('spare_parts', 'part_number', 'TEXT');

// ── Seed admin ───────────────────────────────────────────────────
const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(
  process.env.ADMIN_USERNAME || 'admin'
);
if (!existing) {
  const hash = bcrypt.hashSync(process.env.ADMIN_PASSWORD || 'admin123', 10);
  db.prepare('INSERT INTO users (username, password, name, role) VALUES (?, ?, ?, ?)').run(
    process.env.ADMIN_USERNAME || 'admin',
    hash,
    process.env.ADMIN_NAME || 'Адміністратор',
    'admin'
  );
  console.log('✅ Admin user created');
}

module.exports = db;
