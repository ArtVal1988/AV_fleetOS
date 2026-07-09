const router = require('express').Router();
const db = require('../db');
const { auth } = require('./auth');

// GET /api/vehicles — service data for all vehicles
router.get('/', auth, (req, res) => {
  const rows = db.prepare('SELECT * FROM vehicles').all();
  const result = {};
  rows.forEach(r => { result[r.id] = JSON.parse(r.service_data); });
  res.json(result);
});

// PUT /api/vehicles/:id — save service data for one vehicle
router.put('/:id', auth, (req, res) => {
  const { id } = req.params;
  const data = JSON.stringify(req.body);
  const existing = db.prepare('SELECT id FROM vehicles WHERE id = ?').get(id);
  if (existing) {
    db.prepare('UPDATE vehicles SET service_data = ? WHERE id = ?').run(data, id);
  } else {
    db.prepare('INSERT INTO vehicles (id, service_data) VALUES (?, ?)').run(id, data);
  }
  res.json({ ok: true });
});

module.exports = router;
