const router = require('express').Router();
const db = require('../db');
const { auth } = require('./auth');
const { logActivity } = require('../activityLog');

function bookingSummary(b) {
  const name = b?.customer?.name || '';
  return `${name ? name + ' · ' : ''}${b?.start || ''}–${b?.end || ''}`.trim();
}

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

  logActivity({
    action: 'create', entityType: 'booking', entityId: result.lastInsertRowid,
    summary: bookingSummary(b), snapshot: { ...b, id: result.lastInsertRowid },
    userName: req.user?.name || req.user?.username,
  });

  res.status(201).json({ id: result.lastInsertRowid });
});

// PUT /api/bookings/:id
router.put('/:id', auth, (req, res) => {
  const row = db.prepare('SELECT id, data FROM bookings WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Замовлення не знайдено' });

  const before = JSON.parse(row.data);
  const b = req.body;
  db.prepare(`
    UPDATE bookings
    SET vehicle_id = ?, status = ?, start_date = ?, end_date = ?,
        data = ?, updated_at = datetime('now')
    WHERE id = ?
  `).run(b.vehicleId, b.status, b.start, b.end, JSON.stringify(b), req.params.id);

  logActivity({
    action: 'update', entityType: 'booking', entityId: req.params.id,
    summary: bookingSummary(b), snapshot: { before, after: { ...b, id: Number(req.params.id) } },
    userName: req.user?.name || req.user?.username,
  });

  res.json({ ok: true });
});

// DELETE /api/bookings/:id
router.delete('/:id', auth, (req, res) => {
  const row = db.prepare('SELECT id, data FROM bookings WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Замовлення не знайдено' });
  const deletedData = { ...JSON.parse(row.data), id: row.id };
  db.prepare('DELETE FROM bookings WHERE id = ?').run(req.params.id);

  logActivity({
    action: 'delete', entityType: 'booking', entityId: req.params.id,
    summary: bookingSummary(deletedData), snapshot: deletedData,
    userName: req.user?.name || req.user?.username,
  });

  res.json({ ok: true });
});

// GET /api/bookings/:id/history — this booking's own change history
// (create/update/delete entries), most recent first. Available to any
// authenticated user (not admin-only, unlike the global activity feed),
// since viewing the history of a booking you're already viewing/editing
// is reasonable for any staff member managing it.
router.get('/:id/history', auth, (req, res) => {
  const rows = db.prepare(
    'SELECT * FROM activity_log WHERE entity_type = ? AND entity_id = ? ORDER BY created_at DESC'
  ).all('booking', Number(req.params.id));
  res.json(rows.map(r => ({ ...r, snapshot: r.snapshot ? JSON.parse(r.snapshot) : null })));
});

module.exports = router;
