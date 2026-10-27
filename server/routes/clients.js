const router = require('express').Router();
const db = require('../db');
const { auth } = require('./auth');
const { logReq, diffData, changedLabels, CLIENT_LABELS } = require('../activityLog');

function clientSummary(c) {
  return (c.category && c.category !== 'individual') ? (c.companyName || c.name || '') : (c.name || '');
}

// GET /api/clients — all clients
router.get('/', auth, (req, res) => {
  const rows = db.prepare('SELECT * FROM clients ORDER BY created_at DESC').all();
  res.json(rows.map(r => ({ ...JSON.parse(r.data), id: r.id, createdAt: r.created_at })));
});

// POST /api/clients — create a new client
router.post('/', auth, (req, res) => {
  const result = db.prepare('INSERT INTO clients (data, created_at) VALUES (?, datetime(\'now\'))').run(JSON.stringify(req.body));
  logReq(req, {
    action: 'create', entityType: 'client', entityId: result.lastInsertRowid,
    summary: clientSummary(req.body), snapshot: { ...req.body, id: result.lastInsertRowid },
    details: [req.body.phone ? { label: 'Телефон', to: req.body.phone } : null].filter(Boolean),
  });
  res.status(201).json({ id: result.lastInsertRowid });
});

// PUT /api/clients/:id — update an existing client
router.put('/:id', auth, (req, res) => {
  const row = db.prepare('SELECT id, data FROM clients WHERE id = ?').get(req.params.id);
  const before = row ? JSON.parse(row.data) : null;
  db.prepare('UPDATE clients SET data = ? WHERE id = ?').run(JSON.stringify(req.body), req.params.id);
  const changes = diffData(before, req.body, CLIENT_LABELS);
  if (changes.length) {
    logReq(req, {
      action: 'update', entityType: 'client', entityId: req.params.id,
      summary: `${clientSummary(req.body)} — ${changedLabels(changes)}`,
      snapshot: { before, after: { ...req.body, id: Number(req.params.id) } },
      details: changes,
    });
  }
  res.json({ ok: true });
});

// DELETE /api/clients/:id
router.delete('/:id', auth, (req, res) => {
  if (req.user?.role !== 'admin') return res.status(403).json({ error: 'Видаляти клієнтів може лише адміністратор' });
  const row = db.prepare('SELECT id, data FROM clients WHERE id = ?').get(req.params.id);
  const deletedData = row ? { ...JSON.parse(row.data), id: row.id } : null;
  db.prepare('DELETE FROM clients WHERE id = ?').run(req.params.id);
  logReq(req, {
    action: 'delete', entityType: 'client', entityId: req.params.id,
    summary: deletedData ? clientSummary(deletedData) : null, snapshot: deletedData,
  });
  res.json({ ok: true });
});

module.exports = router;
