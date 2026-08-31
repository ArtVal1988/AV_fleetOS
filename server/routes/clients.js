const router = require('express').Router();
const db = require('../db');
const { auth } = require('./auth');

// GET /api/clients — all clients
router.get('/', auth, (req, res) => {
  const rows = db.prepare('SELECT * FROM clients ORDER BY created_at DESC').all();
  res.json(rows.map(r => ({ ...JSON.parse(r.data), id: r.id, createdAt: r.created_at })));
});

// POST /api/clients — create a new client
router.post('/', auth, (req, res) => {
  const result = db.prepare('INSERT INTO clients (data, created_at) VALUES (?, datetime(\'now\'))').run(JSON.stringify(req.body));
  res.status(201).json({ id: result.lastInsertRowid });
});

// PUT /api/clients/:id — update an existing client
router.put('/:id', auth, (req, res) => {
  db.prepare('UPDATE clients SET data = ? WHERE id = ?').run(JSON.stringify(req.body), req.params.id);
  res.json({ ok: true });
});

// DELETE /api/clients/:id
router.delete('/:id', auth, (req, res) => {
  db.prepare('DELETE FROM clients WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

module.exports = router;
