const router = require('express').Router();
const db = require('../db');
const { auth } = require('./auth');
const { logReq, diffData, changedLabels, VEHICLE_DIFF_LABELS } = require('../activityLog');

function vehiclePlatePrefix(before, after) {
  const plate = (after && after.plate) || (before && before.plate) || '';
  return plate ? `${plate} — ` : '';
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
  const prefix = vehiclePlatePrefix(before, req.body);
  if (!existing) {
    logReq(req, {
      action: 'create', entityType: 'vehicle', entityId: id,
      summary: `${prefix}Додано автомобіль${req.body.name ? ' ' + req.body.name : ''}`, snapshot: { before, after: req.body },
    });
  } else {
    // One save can touch several areas — each gets its own log entry so the
    // log can be filtered by «Ремонти і ТО» / «Страхування» / «Авто (дані)».
    const MAINT = ['works', 'service', 'serviceInterval', 'currentKm', 'nextServiceKm', 'currentKmDate'];
    const INSUR = ['insuranceCases', 'osago', 'kasko', 'insurance'];
    const pick = (o, keys, invert) => {
      const r = {};
      Object.keys(o || {}).forEach(k => { if (keys.includes(k) !== !!invert) r[k] = o[k]; });
      return r;
    };
    const parts = [
      { type: 'maintenance', keys: MAINT, invert: false },
      { type: 'insurance', keys: INSUR, invert: false },
      { type: 'vehicle', keys: [...MAINT, ...INSUR], invert: true },
    ];
    for (const part of parts) {
      const b = pick(before, part.keys, part.invert), a = pick(req.body, part.keys, part.invert);
      const changes = diffData(b, a, VEHICLE_DIFF_LABELS);
      if (!changes.length) continue;
      logReq(req, {
        action: 'update', entityType: part.type, entityId: id,
        summary: `${prefix}${changedLabels(changes)}`, snapshot: { before: b, after: a },
        details: changes,
      });
    }
  }
  res.json({ ok: true });
});

module.exports = router;
