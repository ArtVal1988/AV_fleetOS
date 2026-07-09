const router = require('express').Router();
const db = require('../db');
const { auth } = require('./auth');

// GET /api/bookings
router.get('/', auth, (req, res) => {
  const rows = db.prepare('SELECT * FROM bookings ORDER BY start_date DESC').all();
  const bookings = rows.map(r => ({
    ...JSON.parse(r.data),
    id: r.id,
    vehicleId: r.vehicle_id,
    status: r.status,
    start: r.start_date,
    end: r.end_date,
    _createdAt: r.created_at,
    _updatedAt: r.updated_at,
    _createdBy: r.created_by,
  }));
  res.json(bookings);
});

// GET /api/bookings/:id
router.get('/:id', auth, (req, res) => {
  const row = db.prepare('SELECT * FROM bookings WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Замовлення не знайдено' });
  res.json({ ...JSON.parse(row.data), id: row.id, status: row.status });
});

// POST /api/bookings
router.post('/', auth, (req, res) => {
  const b = req.body;
  if (!b.vehicleId || !b.start || !b.end)
    return res.status(400).json({ error: 'vehicleId, start і end обовʼязкові' });

  const data = JSON.stringify(b);
  const result = db.prepare(`
    INSERT INTO bookings (vehicle_id, status, start_date, end_date, data, created_by)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(b.vehicleId, b.status || 'reserved', b.start, b.end, data, req.user.id);

  res.status(201).json({ id: result.lastInsertRowid });
});

// PUT /api/bookings/:id
router.put('/:id', auth, (req, res) => {
  const row = db.prepare('SELECT id FROM bookings WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Замовлення не знайдено' });

  const b = req.body;
  db.prepare(`
    UPDATE bookings
    SET vehicle_id = ?, status = ?, start_date = ?, end_date = ?,
        data = ?, updated_at = datetime('now')
    WHERE id = ?
  `).run(b.vehicleId, b.status, b.start, b.end, JSON.stringify(b), req.params.id);

  res.json({ ok: true });
});

// DELETE /api/bookings/:id
router.delete('/:id', auth, (req, res) => {
  const row = db.prepare('SELECT id FROM bookings WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Замовлення не знайдено' });
  db.prepare('DELETE FROM bookings WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

module.exports = router;
