const router = require('express').Router();
const db = require('../db');
const { auth } = require('./auth');

router.get('/', auth, (req, res) => {
  const rows = db.prepare('SELECT * FROM stickers ORDER BY created_at ASC').all();
  res.json(rows.map(r => ({ ...JSON.parse(r.data), id: r.id })));
});

router.post('/', auth, (req, res) => {
  const result = db.prepare('INSERT INTO stickers (data) VALUES (?)').run(JSON.stringify(req.body));
  res.status(201).json({ id: result.lastInsertRowid });
});

router.put('/:id', auth, (req, res) => {
  db.prepare('UPDATE stickers SET data = ? WHERE id = ?').run(JSON.stringify(req.body), req.params.id);
  res.json({ ok: true });
});

router.delete('/:id', auth, (req, res) => {
  db.prepare('DELETE FROM stickers WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

module.exports = router;
