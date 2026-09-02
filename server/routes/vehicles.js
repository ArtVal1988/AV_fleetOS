const router = require('express').Router();
const db = require('../db');
const { auth } = require('./auth');
const { logActivity } = require('../activityLog');

function vehicleUpdateSummary(before, after) {
  if (before && after && before.currentKm !== after.currentKm && after.currentKm != null) {
    return `Пробіг: ${before.currentKm ?? '—'} → ${after.currentKm} км`;
  }
  return 'Оновлено дані автомобіля';
}

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
  const existing = db.prepare('SELECT id, service_data FROM vehicles WHERE id = ?').get(id);
  const before = existing ? JSON.parse(existing.service_data) : null;
  if (existing) {
    db.prepare('UPDATE vehicles SET service_data = ? WHERE id = ?').run(data, id);
  } else {
    db.prepare('INSERT INTO vehicles (id, service_data) VALUES (?, ?)').run(id, data);
  }
  logActivity({
    action: existing ? 'update' : 'create', entityType: 'vehicle', entityId: id,
    summary: vehicleUpdateSummary(before, req.body), snapshot: { before, after: req.body },
    userName: req.user?.name || req.user?.username,
  });
  res.json({ ok: true });
});

module.exports = router;
