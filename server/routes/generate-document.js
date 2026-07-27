const router = require('express').Router();
const fs = require('fs');
const path = require('path');
const JSZip = require('jszip');
const multer = require('multer');
const db = require('../db');
const { auth, adminOnly } = require('./auth');

const TEMPLATES_DIR = path.join(__dirname, '..', 'templates');
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });

function fmtDateUk(iso) {
  if (!iso) return '';
  const [y, m, d] = iso.split('-');
  return `${d}.${m}.${y}`;
}
const UK_MONTHS = ['січня','лютого','березня','квітня','травня','червня','липня','серпня','вересня','жовтня','листопада','грудня'];
function fmtDateUkFull(iso) {
  if (!iso) return '';
  const [y, m, d] = iso.split('-');
  return `${parseInt(d)} ${UK_MONTHS[parseInt(m)-1]} ${y} року`;
}
function fmtMoney(n) {
  if (n === null || n === undefined || n === '') return '';
  return Number(n).toLocaleString('uk-UA');
}
function buildClientLegalDescription(client, fallbackName) {
  if (!client) return fallbackName || '';
  const parts = [client.name || fallbackName || ''];
  if (client.birthdate) parts[0] += `, ${fmtDateUk(client.birthdate)} року народження`;
  const passportBits = [];
  if (client.passportNum) passportBits.push(`Паспорт №${client.passportNum}`);
  if (client.passportDate) passportBits.push(`виданий ${fmtDateUk(client.passportDate)} року`);
  if (passportBits.length) parts.push(passportBits.join(', ') + (client.passportIssuer ? ' ' + client.passportIssuer : ''));
  return parts.join('. ');
}
function countDays(start, end) {
  const s = new Date(start), e = new Date(end);
  return Math.max(1, Math.round((e - s) / 86400000) + 1);
}

// ── FIELD CATALOG ────────────────────────────────────────────────
// Every entry here can be picked as the source for a template variable in
// the admin UI. `get(ctx)` computes the actual value at generation time.
// Add a new entry here whenever a new useful field should be available for
// mapping — no other code changes needed, it appears in the admin dropdown
// automatically.
const FIELD_CATALOG = [
  { key: 'booking_id', label: 'Номер замовлення', get: ctx => String(ctx.booking.id) },
  { key: 'today_full', label: 'Сьогоднішня дата (текстом, "26 липня 2026 року")', get: () => fmtDateUkFull(new Date().toISOString().split('T')[0]) },
  { key: 'today_short', label: 'Сьогоднішня дата (числом, 26.07.2026)', get: () => fmtDateUk(new Date().toISOString().split('T')[0]) },
  { key: 'vehicle_name', label: 'Авто: марка і модель', get: ctx => [ctx.vehicle.specs?.brand, ctx.vehicle.specs?.model].filter(Boolean).join(' ') || ctx.vehicle.name || '' },
  { key: 'vehicle_plate', label: 'Авто: номерний знак', get: ctx => ctx.vehicle.plate || '' },
  { key: 'vehicle_vin', label: 'Авто: номер кузова (VIN)', get: ctx => ctx.vehicle.vin || '' },
  { key: 'vehicle_sts', label: 'Авто: серія/номер техпаспорта', get: ctx => ctx.vehicle.sts?.number || '' },
  { key: 'vehicle_color', label: 'Авто: колір', get: ctx => ctx.vehicle.specs?.color || '' },
  { key: 'vehicle_year', label: 'Авто: рік випуску', get: ctx => ctx.vehicle.specs?.year || '' },
  { key: 'client_name', label: 'Клієнт: ПІБ', get: ctx => ctx.client?.name || ctx.booking.customer?.name || '' },
  { key: 'client_phone', label: 'Клієнт: телефон', get: ctx => ctx.client?.phone || ctx.booking.customer?.phone || '' },
  { key: 'client_legal', label: 'Клієнт: повний юридичний опис (ПІБ, дата народження, паспорт)', get: ctx => buildClientLegalDescription(ctx.client, ctx.booking.customer?.name) },
  { key: 'client_inn', label: 'Клієнт: ІПН', get: ctx => ctx.client?.inn || ctx.booking.customer?.edrpou || '' },
  { key: 'client_address', label: 'Клієнт: адреса реєстрації', get: ctx => ctx.client?.address || '' },
  { key: 'client_license_num', label: 'Клієнт: номер посвідчення водія', get: ctx => ctx.client?.licenseNum || '' },
  { key: 'client_license_cat', label: 'Клієнт: категорія посвідчення', get: ctx => ctx.client?.licenseCat || '' },
  { key: 'company_name', label: 'Компанія-наймач (юрособа), якщо є', get: ctx => ctx.booking.customer?.company || '' },
  { key: 'rental_start', label: 'Дата отримання авто', get: ctx => fmtDateUk(ctx.booking.start) },
  { key: 'rental_end', label: 'Дата повернення авто', get: ctx => fmtDateUk(ctx.booking.end) },
  { key: 'rental_days', label: 'Кількість діб оренди', get: ctx => String(countDays(ctx.booking.start, ctx.booking.end)) },
  { key: 'pickup_time', label: 'Час отримання', get: ctx => ctx.booking.pickup?.time || '' },
  { key: 'pickup_address', label: 'Адреса отримання', get: ctx => ctx.booking.pickup?.address || 'Офіс, вул. Антоновича, 112' },
  { key: 'return_time', label: 'Час повернення', get: ctx => ctx.booking.ret?.time || '' },
  { key: 'return_address', label: 'Адреса повернення', get: ctx => ctx.booking.ret?.address || 'Офіс, вул. Антоновича, 112' },
  { key: 'rate_per_day', label: 'Тариф за добу', get: ctx => fmtMoney(ctx.booking.rate) },
  { key: 'currency', label: 'Валюта замовлення', get: ctx => ctx.booking.currency || '' },
  { key: 'total_amount', label: 'Загальна вартість оренди', get: ctx => fmtMoney((ctx.booking.rate||0) * countDays(ctx.booking.start, ctx.booking.end)) },
  { key: 'deposit', label: 'Сума застави (депозиту)', get: ctx => fmtMoney(ctx.booking.deposit) },
  { key: 'pay_method', label: 'Спосіб оплати послуг', get: ctx => ctx.booking.payMethod === 'card' ? 'Банківська картка' : ctx.booking.payMethod === 'cash' ? 'Готівка' : '' },
  { key: 'deposit_pay_method', label: 'Спосіб оплати застави', get: ctx => ctx.booking.depositPayMethod === 'card' ? 'Банківська картка' : ctx.booking.depositPayMethod === 'cash' ? 'Готівка' : '' },
  { key: 'status_label', label: 'Статус замовлення', get: ctx => ctx.booking.status || '' },
  { key: 'notes', label: 'Нотатки замовлення', get: ctx => ctx.booking.notes || '' },
  { key: 'blank', label: '(порожньо — залишити поле для ручного заповнення)', get: () => '' },
];

function getFieldValue(key, ctx) {
  if (!key) return '';
  if (key.startsWith('static:')) {
    return key.slice('static:'.length);
  }
  if (key.startsWith('path:')) {
    return resolveDataPath(key.slice('path:'.length), ctx);
  }
  const entry = FIELD_CATALOG.find(f => f.key === key);
  if (!entry) return '';
  try { return entry.get(ctx) || ''; } catch (e) { return ''; }
}

// Safe, limited dot-path resolver — NOT eval(), just plain property lookups
// on the booking/vehicle/client context objects. Lets an admin reference any
// field without needing a new catalog entry for every possible data point,
// e.g. "booking.rate", "vehicle.specs.color", "client.passportNum".
function resolveDataPath(pathStr, ctx) {
  const root = { booking: ctx.booking, vehicle: ctx.vehicle, client: ctx.client || {} };
  const parts = String(pathStr).trim().split('.').filter(Boolean);
  let cur = root;
  for (const part of parts) {
    if (cur === null || cur === undefined) return '';
    if (!Object.prototype.hasOwnProperty.call(cur, part) && typeof cur !== 'object') return '';
    cur = cur[part];
  }
  if (cur === null || cur === undefined) return '';
  if (typeof cur === 'object') return ''; // don't dump raw objects into a document
  return String(cur);
}

// ── Mapping storage (reuses the settings table) ─────────────────
const MAPPING_SETTINGS_KEY = 'document_variable_mapping';
const DEFAULT_MAPPING = {
  contract: {
    'номер': 'booking_id', 'дата': 'today_full', 'фирма1': 'vehicle_name', 'код1': 'vehicle_plate',
    'фирма2': 'client_legal', 'код2': 'client_inn', 'лицо2': 'client_name', 'адрес2': 'client_phone',
  },
  act: {
    'номер': 'booking_id', 'дата': 'today_full', 'фирма1': 'vehicle_name', 'код1': 'vehicle_plate',
    'счет1': 'vehicle_vin', 'адрес1': 'vehicle_sts', 'лицо2': 'client_name', 'адрес2': 'client_phone',
  },
};
function getMapping() {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(MAPPING_SETTINGS_KEY);
  return row ? JSON.parse(row.value) : DEFAULT_MAPPING;
}
function setMapping(mapping) {
  const json = JSON.stringify(mapping);
  const existing = db.prepare('SELECT key FROM settings WHERE key = ?').get(MAPPING_SETTINGS_KEY);
  if (existing) db.prepare('UPDATE settings SET value = ?, updated_at = datetime(\'now\') WHERE key = ?').run(json, MAPPING_SETTINGS_KEY);
  else db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run(MAPPING_SETTINGS_KEY, json);
}

// Scan a docx template for #placeholder tokens (Cyrillic/Latin/digits)
async function scanTemplatePlaceholders(templatePath) {
  if (!fs.existsSync(templatePath)) return [];
  const buf = fs.readFileSync(templatePath);
  const zip = await JSZip.loadAsync(buf);
  const xml = await zip.file('word/document.xml').async('string');
  const matches = xml.match(/#[а-яА-ЯіІїЇєЄa-zA-Z0-9_]+/g) || [];
  return [...new Set(matches.map(m => m.slice(1)))];
}

function escapeXml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

async function fillTemplate(templatePath, values) {
  const buf = fs.readFileSync(templatePath);
  const zip = await JSZip.loadAsync(buf);
  let xml = await zip.file('word/document.xml').async('string');
  Object.keys(values).forEach(key => {
    const token = '#' + key;
    xml = xml.split(token).join(escapeXml(values[key]));
  });
  zip.file('word/document.xml', xml);
  return zip.generateAsync({ type: 'nodebuffer' });
}

function getBookingContext(bookingId) {
  const row = db.prepare('SELECT * FROM bookings WHERE id = ?').get(bookingId);
  if (!row) return null;
  const b = { ...JSON.parse(row.data), id: row.id, vehicleId: row.vehicle_id, start: row.start_date, end: row.end_date };

  const vRow = db.prepare('SELECT service_data FROM vehicles WHERE id = ?').get(b.vehicleId);
  const vehicle = vRow ? JSON.parse(vRow.service_data) : {};

  let client = null;
  if (b.customer && b.customer.clientId) {
    const cRow = db.prepare('SELECT * FROM clients WHERE id = ?').get(b.customer.clientId);
    if (cRow) client = { ...JSON.parse(cRow.data), id: cRow.id };
  }

  return { booking: b, vehicle, client };
}

// ── Admin: field catalog ────────────────────────────────────────
router.get('/fields', auth, adminOnly, (req, res) => {
  res.json(FIELD_CATALOG.map(f => ({ key: f.key, label: f.label })));
});

// ── Admin: mapping get/set ───────────────────────────────────────
router.get('/mapping', auth, adminOnly, async (req, res) => {
  const mapping = getMapping();
  const contractPlaceholders = await scanTemplatePlaceholders(path.join(TEMPLATES_DIR, 'dogovir.docx'));
  const actPlaceholders = await scanTemplatePlaceholders(path.join(TEMPLATES_DIR, 'akt.docx'));
  res.json({ mapping, contractPlaceholders, actPlaceholders });
});
router.put('/mapping', auth, adminOnly, (req, res) => {
  setMapping(req.body);
  res.json({ ok: true });
});

// ── Admin: template upload ───────────────────────────────────────
router.post('/template/:type', auth, adminOnly, upload.single('file'), (req, res) => {
  const { type } = req.params;
  if (!['contract', 'act'].includes(type)) return res.status(400).json({ error: 'Невідомий тип шаблону' });
  if (!req.file) return res.status(400).json({ error: 'Файл не завантажено' });
  const fileName = type === 'contract' ? 'dogovir.docx' : 'akt.docx';
  if (!fs.existsSync(TEMPLATES_DIR)) fs.mkdirSync(TEMPLATES_DIR, { recursive: true });
  fs.writeFileSync(path.join(TEMPLATES_DIR, fileName), req.file.buffer);
  res.json({ ok: true });
});

// GET /api/generate-document/:bookingId/:type  (type = contract | act)
router.get('/:bookingId/:type', auth, async (req, res) => {
  const { bookingId, type } = req.params;
  if (!['contract', 'act'].includes(type)) {
    return res.status(400).json({ error: 'Невідомий тип документа' });
  }

  const ctx = getBookingContext(bookingId);
  if (!ctx) return res.status(404).json({ error: 'Замовлення не знайдено' });

  const templateFile = type === 'contract' ? 'dogovir.docx' : 'akt.docx';
  const templatePath = path.join(TEMPLATES_DIR, templateFile);
  if (!fs.existsSync(templatePath)) return res.status(404).json({ error: 'Шаблон не знайдено' });

  const mapping = getMapping()[type] || {};
  const placeholders = await scanTemplatePlaceholders(templatePath);
  const values = {};
  placeholders.forEach(ph => {
    values[ph] = getFieldValue(mapping[ph], ctx);
  });

  try {
    const fileBuffer = await fillTemplate(templatePath, values);
    const vehicleName = getFieldValue('vehicle_name', ctx);
    const clientName = getFieldValue('client_name', ctx);
    const vehiclePlate = getFieldValue('vehicle_plate', ctx);
    const fileName = (type === 'contract' ? 'Договір' : 'Акт') + `_${ctx.booking.id}_${vehicleName}.docx`;

    // Archive every generated document — a permanent record independent of
    // later booking edits, so "what was actually handed to the client" is
    // always retrievable even if the booking data changes afterward.
    try {
      db.prepare(`INSERT INTO generated_documents (booking_id, doc_type, file_name, file_data, client_name, vehicle_name, vehicle_plate, generated_by)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(Number(bookingId), type, fileName, fileBuffer, clientName, vehicleName, vehiclePlate, req.user?.name || req.user?.username || '');
    } catch (archiveErr) {
      console.error('Failed to archive generated document (continuing anyway):', archiveErr);
    }

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(fileName)}"`);
    res.send(fileBuffer);
  } catch (err) {
    console.error('Document generation error:', err);
    res.status(500).json({ error: 'Помилка генерації документа' });
  }
});

// ── Document archive ─────────────────────────────────────────────
// GET /api/generate-document/archive/list — list all generated documents (no file data, just metadata)
router.get('/archive/list', auth, (req, res) => {
  const rows = db.prepare(`SELECT id, booking_id, doc_type, file_name, client_name, vehicle_name, vehicle_plate, generated_by, created_at
                            FROM generated_documents ORDER BY created_at DESC`).all();
  res.json(rows);
});

// GET /api/generate-document/archive/:id — download a specific archived document
router.get('/archive/:id', auth, (req, res) => {
  const row = db.prepare('SELECT * FROM generated_documents WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Документ не знайдено' });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(row.file_name)}"`);
  res.send(row.file_data);
});

// DELETE /api/generate-document/archive/:id
router.delete('/archive/:id', auth, adminOnly, (req, res) => {
  db.prepare('DELETE FROM generated_documents WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

module.exports = router;
