const router = require('express').Router();
const db = require('../db');
const { auth } = require('./auth');
const { logActivity } = require('../activityLog');

function stickerSummary(s) {
  const text = (s.text || '').trim();
  return text.length > 60 ? text.slice(0, 60) + '…' : (text || s.title || '');
}

router.get('/', auth, (req, res) => {
  const rows = db.prepare('SELECT * FROM stickers ORDER BY created_at ASC').all();
  res.json(rows.map(r => ({ ...JSON.parse(r.data), id: r.id })));
});

router.post('/', auth, (req, res) => {
  const result = db.prepare('INSERT INTO stickers (data) VALUES (?)').run(JSON.stringify(req.body));
  logActivity({
    action: 'create', entityType: 'sticker', entityId: result.lastInsertRowid,
    summary: stickerSummary(req.body), snapshot: { ...req.body, id: result.lastInsertRowid },
    userName: req.user?.name || req.user?.username,
  });
  res.status(201).json({ id: result.lastInsertRowid });
});

router.put('/:id', auth, (req, res) => {
  const row = db.prepare('SELECT id, data FROM stickers WHERE id = ?').get(req.params.id);
  const before = row ? JSON.parse(row.data) : null;
  db.prepare('UPDATE stickers SET data = ? WHERE id = ?').run(JSON.stringify(req.body), req.params.id);
  logActivity({
    action: 'update', entityType: 'sticker', entityId: req.params.id,
    summary: stickerSummary(req.body), snapshot: { before, after: { ...req.body, id: Number(req.params.id) } },
    userName: req.user?.name || req.user?.username,
  });
  res.json({ ok: true });
});

router.delete('/:id', auth, (req, res) => {
  const row = db.prepare('SELECT id, data FROM stickers WHERE id = ?').get(req.params.id);
  const deletedData = row ? { ...JSON.parse(row.data), id: row.id } : null;
  db.prepare('DELETE FROM stickers WHERE id = ?').run(req.params.id);
  logActivity({
    action: 'delete', entityType: 'sticker', entityId: req.params.id,
    summary: deletedData ? stickerSummary(deletedData) : null, snapshot: deletedData,
    userName: req.user?.name || req.user?.username,
  });
  res.json({ ok: true });
});

module.exports = router;
