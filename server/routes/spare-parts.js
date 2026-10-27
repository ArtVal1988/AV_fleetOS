const router = require('express').Router();
const db = require('../db');
const { auth } = require('./auth');
const { logReq, diffData, changedLabels } = require('../activityLog');
const PART_LABELS = { name: 'Назва', part_number: 'Артикул', quantity: 'Кількість', price: 'Ціна', supplier: 'Постачальник', manufacturer: 'Виробник' };
const partLabel = r => [r.name, r.part_number].filter(Boolean).join(' · ');

// GET /api/spare-parts — list all parts, newest-name-first is unhelpful, sort by name
router.get('/', auth, (req, res) => {
  const rows = db.prepare('SELECT * FROM spare_parts ORDER BY name COLLATE NOCASE').all();
  res.json(rows);
});

// POST /api/spare-parts — add a new part
router.post('/', auth, (req, res) => {
  const { name, partNumber, quantity, price, supplier, manufacturer } = req.body;
  if (!name || !String(name).trim()) return res.status(400).json({ error: 'Назва обов\'язкова' });
  const info = db.prepare(
    `INSERT INTO spare_parts (name, part_number, quantity, price, supplier, manufacturer, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, datetime('now'))`
  ).run(String(name).trim(), partNumber ? String(partNumber).trim() : null, Number(quantity) || 0, Number(price) || 0, supplier ? String(supplier).trim() : null, manufacturer ? String(manufacturer).trim() : null);
  const row = db.prepare('SELECT * FROM spare_parts WHERE id = ?').get(info.lastInsertRowid);
  logReq(req, {
    action: 'create', entityType: 'spare_part', entityId: row.id,
    summary: partLabel(row), snapshot: row,
    details: [{ label: 'Кількість', to: String(row.quantity) }, { label: 'Ціна', to: String(row.price) }],
  });
  res.json(row);
});

// PUT /api/spare-parts/:id — edit a part
router.put('/:id', auth, (req, res) => {
  const id = Number(req.params.id);
  const existing = db.prepare('SELECT * FROM spare_parts WHERE id = ?').get(id);
  if (!existing) return res.status(404).json({ error: 'Не знайдено' });
  const { name, partNumber, quantity, price, supplier, manufacturer } = req.body;
  db.prepare(
    `UPDATE spare_parts SET name=?, part_number=?, quantity=?, price=?, supplier=?, manufacturer=?, updated_at=datetime('now') WHERE id=?`
  ).run(
    name != null ? String(name).trim() : existing.name,
    partNumber != null ? String(partNumber).trim() : existing.part_number,
    quantity != null ? Number(quantity) : existing.quantity,
    price != null ? Number(price) : existing.price,
    supplier != null ? String(supplier).trim() : existing.supplier,
    manufacturer != null ? String(manufacturer).trim() : existing.manufacturer,
    id
  );
  const updated = db.prepare('SELECT * FROM spare_parts WHERE id = ?').get(id);
  const changes = diffData(existing, updated, PART_LABELS);
  if (changes.length) {
    logReq(req, {
      action: 'update', entityType: 'spare_part', entityId: id,
      summary: `${partLabel(updated)} — ${changedLabels(changes)}`, snapshot: { before: existing, after: updated },
      details: changes,
    });
  }
  res.json(updated);
});

// DELETE /api/spare-parts/:id
router.delete('/:id', auth, (req, res) => {
  const id = Number(req.params.id);
  const existing = db.prepare('SELECT * FROM spare_parts WHERE id = ?').get(id);
  if (!existing) return res.status(404).json({ error: 'Не знайдено' });
  db.prepare('DELETE FROM spare_parts WHERE id = ?').run(id);
  logReq(req, { action: 'delete', entityType: 'spare_part', entityId: id, summary: partLabel(existing), snapshot: existing });
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
  logReq(req, {
    action: 'update', entityType: 'spare_part', entityId: id,
    summary: `${partLabel(existing)} — ${amount >= 0 ? 'списано зі складу' : 'повернуто на склад'}: ${Math.abs(amount)}`,
    details: [{ label: 'Залишок', from: String(existing.quantity), to: String(newQty) }],
  });
  res.json(db.prepare('SELECT * FROM spare_parts WHERE id = ?').get(id));
});

module.exports = router;
