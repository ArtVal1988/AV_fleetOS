const router = require('express').Router();
const db = require('../db');
const { auth, adminOnly } = require('./auth');

// GET /api/activity-log — list recent entries (most recent first), optional filters
router.get('/', auth, adminOnly, (req, res) => {
  const { entityType, entityId, action, date, limit } = req.query;
  let sql = 'SELECT * FROM activity_log WHERE 1=1';
  const params = [];
  if (entityType) { sql += ' AND entity_type = ?'; params.push(entityType); }
  if (entityId) { sql += ' AND entity_id = ?'; params.push(Number(entityId)); }
  if (action) { sql += ' AND action = ?'; params.push(action); }
  if (date) { sql += " AND DATE(created_at, '+3 hours') = ?"; params.push(date); }
  sql += ' ORDER BY created_at DESC LIMIT ?';
  params.push(Math.min(Number(limit) || 200, 500));
  const rows = db.prepare(sql).all(...params);
  res.json(rows.map(r => ({ ...r, snapshot: r.snapshot ? JSON.parse(r.snapshot) : null })));
});

// POST /api/activity-log/:id/undo — reverses a logged action using its
// stored snapshot (admin only). Currently supports booking actions only,
// since that's the only entity type ever logged.
router.post('/:id/undo', auth, adminOnly, (req, res) => {
  const entry = db.prepare('SELECT * FROM activity_log WHERE id = ?').get(req.params.id);
  if (!entry) return res.status(404).json({ error: 'Запис не знайдено' });
  if (entry.undone_at) return res.status(400).json({ error: 'Цю дію вже скасовано' });
  if (entry.entity_type !== 'booking') return res.status(400).json({ error: 'Скасування підтримується лише для замовлень' });
  if (!entry.snapshot) return res.status(400).json({ error: 'Немає збережених даних для відновлення' });

  const snapshot = JSON.parse(entry.snapshot);
  const bookingId = Number(entry.entity_id);

  if (entry.action === 'delete') {
    const existing = db.prepare('SELECT id FROM bookings WHERE id = ?').get(bookingId);
    if (existing) return res.status(400).json({ error: 'Замовлення з таким ID вже існує — відновлення неможливе' });
    const b = snapshot;
    db.prepare(`
      INSERT INTO bookings (id, vehicle_id, status, start_date, end_date, data, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(bookingId, b.vehicleId, b.status || 'reserved', b.start, b.end, JSON.stringify(b), req.user.id);
  } else if (entry.action === 'create') {
    db.prepare('DELETE FROM bookings WHERE id = ?').run(bookingId);
  } else if (entry.action === 'update') {
    const before = snapshot.before;
    if (!before) return res.status(400).json({ error: 'Немає попереднього стану для відновлення' });
    const existing = db.prepare('SELECT id FROM bookings WHERE id = ?').get(bookingId);
    if (!existing) return res.status(400).json({ error: 'Замовлення більше не існує' });
    db.prepare(`
      UPDATE bookings SET vehicle_id = ?, status = ?, start_date = ?, end_date = ?, data = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(before.vehicleId, before.status, before.start, before.end, JSON.stringify(before), bookingId);
  } else {
    return res.status(400).json({ error: 'Скасування цього типу дії не підтримується' });
  }

  db.prepare("UPDATE activity_log SET undone_at = datetime('now') WHERE id = ?").run(req.params.id);
  db.prepare(`
    INSERT INTO activity_log (action, entity_type, entity_id, summary, user_name)
    VALUES ('undo', 'booking', ?, ?, ?)
  `).run(bookingId, entry.summary, req.user?.name || req.user?.username);

  res.json({ ok: true });
});

module.exports = router;
