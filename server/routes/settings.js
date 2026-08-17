const router = require('express').Router();
const db = require('../db');
const { auth, adminOnly } = require('./auth');

// GET /api/settings — all settings as a { key: value } object.
// Any authenticated user can read (they need the current statuses etc. to use the app).
router.get('/', auth, (req, res) => {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const result = {};
  rows.forEach(r => { try { result[r.key] = JSON.parse(r.value); } catch { /* skip corrupt row */ } });
  res.json(result);
});

// PUT /api/settings/:key — upsert one setting. Admin-only: these are shared
// config that every device/browser sees, so only an admin should change them.
router.put('/:key', auth, adminOnly, (req, res) => {
  const value = JSON.stringify(req.body.value);
  const existing = db.prepare('SELECT key FROM settings WHERE key = ?').get(req.params.key);
  if (existing) {
    db.prepare("UPDATE settings SET value = ?, updated_at = datetime('now') WHERE key = ?").run(value, req.params.key);
  } else {
    db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run(req.params.key, value);
  }
  res.json({ ok: true });
});

module.exports = router;
