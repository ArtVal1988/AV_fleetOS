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

module.exports = router;
