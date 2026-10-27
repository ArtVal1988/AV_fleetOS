const router = require('express').Router();
const db = require('../db');
const { auth, adminOnly } = require('./auth');
const { logReq, diffData, changedLabels } = require('../activityLog');

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
  const existing = db.prepare('SELECT key, value FROM settings WHERE key = ?').get(req.params.key);
  let beforeVal = null;
  try { beforeVal = existing ? JSON.parse(existing.value) : null; } catch (e) { /* ignore */ }
  if (existing) {
    db.prepare("UPDATE settings SET value = ?, updated_at = datetime('now') WHERE key = ?").run(value, req.params.key);
  } else {
    db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run(req.params.key, value);
  }
  let changes = [];
  const bv = beforeVal, av = req.body.value;
  const isObjLike = v => v !== null && typeof v === 'object';
  if (isObjLike(av) && (bv === null || isObjLike(bv))) {
    changes = diffData({ v: bv === null ? undefined : bv }, { v: av }, { v: 'Значення' });
    changes.forEach(c => { c.label = c.label.replace(/^v\./, '') || 'Значення'; });
  } else if (JSON.stringify(bv) !== JSON.stringify(av)) {
    changes = [{ label: 'Значення', from: bv == null ? '—' : JSON.stringify(bv).slice(0, 160), to: JSON.stringify(av).slice(0, 160) }];
  }
  if (changes.length) {
    logReq(req, {
      action: existing ? 'update' : 'create', entityType: 'setting', entityId: null,
      summary: `Налаштування «${req.params.key}» — ${changedLabels(changes)}`,
      snapshot: { before: beforeVal, after: av }, details: changes,
    });
  }
  res.json({ ok: true });
});

module.exports = router;
