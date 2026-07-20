const router = require('express').Router();
const db = require('../db');
const { auth } = require('./auth');

// GET /api/spare-parts — list all parts, newest-name-first is unhelpful, sort by name
router.get('/', auth, (req, res) => {
  const rows = db.prepare('SELECT * FROM spare_parts ORDER BY name COLLATE NOCASE').all();
  res.json(rows);
});

// POST /api/spare-parts — add a new part
router.post('/', auth, (req, res) => {
  const { name, quantity, price, supplier } = req.body;
  if (!name || !String(name).trim()) return res.status(400).json({ error: 'Назва обов\'язкова' });
  const info = db.prepare(
    `INSERT INTO spare_parts (name, quantity, price, supplier, updated_at)
     VALUES (?, ?, ?, ?, datetime('now'))`
  ).run(String(name).trim(), Number(quantity) || 0, Number(price) || 0, supplier ? String(supplier).trim() : null);
  const row = db.prepare('SELECT * FROM spare_parts WHERE id = ?').get(info.lastInsertRowid);
  res.json(row);
});

// PUT /api/spare-parts/:id — edit a part
router.put('/:id', auth, (req, res) => {
  const id = Number(req.params.id);
  const existing = db.prepare('SELECT * FROM spare_parts WHERE id = ?').get(id);
  if (!existing) return res.status(404).json({ error: 'Не знайдено' });
  const { name, quantity, price, supplier } = req.body;
  db.prepare(
    `UPDATE spare_parts SET name=?, quantity=?, price=?, supplier=?, updated_at=datetime('now') WHERE id=?`
  ).run(
    name != null ? String(name).trim() : existing.name,
    quantity != null ? Number(quantity) : existing.quantity,
    price != null ? Number(price) : existing.price,
    supplier != null ? String(supplier).trim() : existing.supplier,
    id
  );
  res.json(db.prepare('SELECT * FROM spare_parts WHERE id = ?').get(id));
});

// DELETE /api/spare-parts/:id
router.delete('/:id', auth, (req, res) => {
  const id = Number(req.params.id);
  const existing = db.prepare('SELECT id FROM spare_parts WHERE id = ?').get(id);
  if (!existing) return res.status(404).json({ error: 'Не знайдено' });
  db.prepare('DELETE FROM spare_parts WHERE id = ?').run(id);
  res.json({ ok: true });
});

// POST /api/spare-parts/:id/deduct — subtract `amount` from stock (used when a
// repair record consumes a part). Negative amount = return to stock (undo).
router.post('/:id/deduct', auth, (req, res) => {
  const id = Number(req.params.id);
  const amount = Number(req.body.amount);
  if (!Number.isFinite(amount)) return res.status(400).json({ error: 'Невірна кількість' });
  const existing = db.prepare('SELECT * FROM spare_parts WHERE id = ?').get(id);
  if (!existing) return res.status(404).json({ error: 'Не знайдено' });
  const newQty = existing.quantity - amount;
  db.prepare(`UPDATE spare_parts SET quantity=?, updated_at=datetime('now') WHERE id=?`).run(newQty, id);
  res.json(db.prepare('SELECT * FROM spare_parts WHERE id = ?').get(id));
});

module.exports = router;
