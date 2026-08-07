const router = require('express').Router();
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const JSZip = require('jszip');
const multer = require('multer');
const db = require('../db');
const { auth, adminOnly } = require('./auth');

const TEMPLATES_DIR = path.join(__dirname, '..', 'templates');
const GENERATED_DOCS_DIR = path.join(__dirname, '..', 'uploads', 'Згенеровані документи');
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
  { key: 'rep_status_type', label: 'ФОП: статус суб\'єкта господарювання', get: ctx => ctx.rep?.statusType || '' },
  { key: 'rep_name', label: 'ФОП: назва (ПІБ) суб\'єкта', get: ctx => ctx.rep?.name || '' },
  { key: 'rep_registry_number', label: 'ФОП: № запису в реєстрі', get: ctx => ctx.rep?.registryNumber || '' },
  { key: 'rep_edrpou', label: 'ФОП: реєстраційний номер / ЄДРПОУ', get: ctx => ctx.rep?.edrpou || '' },
  { key: 'rep_position', label: 'ФОП: посада', get: ctx => ctx.rep?.position || '' },
  { key: 'rep_representative_details', label: 'ФОП: дані представника', get: ctx => ctx.rep?.representativeDetails || '' },
  { key: 'rep_legal_basis', label: 'ФОП: юридичні підстави представника', get: ctx => ctx.rep?.legalBasis || '' },
  { key: 'rep_address', label: 'ФОП: юридична адреса', get: ctx => ctx.rep?.address || '' },
  { key: 'rep_tax_form', label: 'ФОП: форма оподаткування', get: ctx => ctx.rep?.taxForm || '' },
  { key: 'rep_ipn', label: 'ФОП: ІПН (для платників ПДВ)', get: ctx => ctx.rep?.ipn || '' },
  { key: 'rep_iban', label: 'ФОП: номер р/р (IBAN)', get: ctx => ctx.rep?.iban || '' },
  { key: 'rep_bank_name', label: 'ФОП: назва банку', get: ctx => ctx.rep?.bankName || '' },
  { key: 'rep_phone', label: 'ФОП: контактний номер телефону', get: ctx => ctx.rep?.phone || '' },
  { key: 'rep_email', label: 'ФОП: адреса ел. пошти', get: ctx => ctx.rep?.email || '' },
  { key: 'rep_initials', label: 'ФОП: ініціали (для номера договору)', get: ctx => ctx.rep?.initials || '' },
  { key: 'contract_number', label: 'Номер договору (стабільний, спільний для договору та всіх актів)', get: ctx => ctx.booking.contractNumber || '' },
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
    'номер': 'contract_number', 'дата': 'today_full', 'фирма1': 'vehicle_name', 'код1': 'vehicle_plate',
    'фирма2': 'client_legal', 'код2': 'client_inn', 'лицо2': 'client_name', 'адрес2': 'client_phone',
  },
  act: {
    'номер': 'contract_number', 'дата': 'today_full', 'фирма1': 'vehicle_name', 'код1': 'vehicle_plate',
    'счет1': 'vehicle_vin', 'адрес1': 'vehicle_sts', 'лицо2': 'client_name', 'адрес2': 'client_phone',
  },
};
function getMapping(repKey) {
  if (repKey) {
    const repRow = db.prepare('SELECT value FROM settings WHERE key = ?').get(MAPPING_SETTINGS_KEY + '_' + repKey);
    if (repRow) return JSON.parse(repRow.value);
  }
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(MAPPING_SETTINGS_KEY);
  return row ? JSON.parse(row.value) : DEFAULT_MAPPING;
}
function getRepresentatives() {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get('representatives');
  return row ? JSON.parse(row.value) : {};
}
// The 3 legal-form representative slots are fixed (not a free list the user
// picks from per-booking) — the slot is derived automatically from the
// booking's own client type, matching what's configured once in Налаштування.
function repSlotForClientType(clientType) {
  if (clientType === 'individual' || !clientType) return 'individual';
  if (clientType === 'fop_no_vat') return 'business_no_vat';
  return 'business_vat'; // 'fop' or 'tov'
}
// Templates are named per-representative when a representative has their
// own uploaded contract/act (dogovir_{repKey}.docx / akt_{repKey}.docx) —
// falls back to the shared default (dogovir.docx / akt.docx) whenever a
// booking has no representative selected, or that representative hasn't
// had their own template uploaded yet.
function templateFileName(type, repKey) {
  const base = type === 'contract' ? 'dogovir' : 'akt';
  if (repKey) {
    const named = path.join(TEMPLATES_DIR, `${base}_${repKey}.docx`);
    if (fs.existsSync(named)) return `${base}_${repKey}.docx`;
  }
  return `${base}.docx`;
}
// The contract number stays the same for a booking across every document
// generated under it (the contract itself, and every act — a booking can
// reasonably end up with more than one act generated over its lifetime,
// e.g. after edits or re-issues, but they all belong to the same contract).
// Format: {ініціали ФОП}-{номер авто}-{ддммрррр}-{ггхх}, e.g. СНК-КА_5119_ЕС-06082026-1432.
// Generated once, on whichever document (contract or act) is generated
// first for that booking, then persisted onto the booking so it's stable.
// Server runs in UTC, but the business operates in Ukraine — always format
// dates/times in Europe/Kyiv explicitly rather than relying on the server's
// local timezone, otherwise contract numbers end up several hours off.
function getKyivDateParts(date) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Kyiv',
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(date);
  const get = t => parts.find(p => p.type === t).value;
  return { dd: get('day'), mm: get('month'), yyyy: get('year'), hh: get('hour'), min: get('minute') };
}
function getOrCreateContractNumber(ctx, bookingId) {
  if (ctx.booking.contractNumber) return ctx.booking.contractNumber;

  const initials = (ctx.rep?.initials || 'XXX').trim() || 'XXX';
  const platePart = (ctx.vehicle?.plate || '').trim().replace(/\s+/g, '') || 'XX';
  const { dd, mm, yyyy, hh, min } = getKyivDateParts(new Date());
  const contractNumber = `${initials}-${platePart}-${dd}${mm}${yyyy}-${hh}${min}`;

  // Persist onto the booking's own data blob so it survives independently
  // of this request and is stably reused for every later document.
  const row = db.prepare('SELECT data FROM bookings WHERE id = ?').get(bookingId);
  if (row) {
    const data = JSON.parse(row.data);
    data.contractNumber = contractNumber;
    db.prepare('UPDATE bookings SET data = ? WHERE id = ?').run(JSON.stringify(data), bookingId);
  }
  ctx.booking.contractNumber = contractNumber;
  return contractNumber;
}
function setMapping(mapping, repKey) {
  const settingsKey = repKey ? MAPPING_SETTINGS_KEY + '_' + repKey : MAPPING_SETTINGS_KEY;
  const json = JSON.stringify(mapping);
  const existing = db.prepare('SELECT key FROM settings WHERE key = ?').get(settingsKey);
  if (existing) db.prepare('UPDATE settings SET value = ?, updated_at = datetime(\'now\') WHERE key = ?').run(json, settingsKey);
  else db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run(settingsKey, json);
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

  const repSlot = repSlotForClientType(b.clientType);
  const reps = getRepresentatives();
  const rep = reps[repSlot] || null;

  return { booking: b, vehicle, client, rep, repSlot };
}

// ── Admin: field catalog ────────────────────────────────────────
router.get('/fields', auth, adminOnly, (req, res) => {
  res.json(FIELD_CATALOG.map(f => ({ key: f.key, label: f.label })));
});

// ── Admin: mapping get/set ───────────────────────────────────────
function getTemplateInfo(actualFileName, base, repKey) {
  // actualFileName tells us whether templateFileName() resolved to the
  // rep-specific file or fell back to the shared default — look up info
  // under whichever one is actually in use, not necessarily the requested repKey.
  const isRepSpecific = repKey && actualFileName === `${base}_${repKey}.docx`;
  const infoKey = 'template_info_' + base + '_' + (isRepSpecific ? repKey : 'default');
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(infoKey);
  return row ? { ...JSON.parse(row.value), isFallback: !isRepSpecific } : null;
}
router.get('/mapping', auth, adminOnly, async (req, res) => {
  const repKey = (req.query.repKey || '').trim() || null;
  const mapping = getMapping(repKey);
  const contractFile = templateFileName('contract', repKey);
  const actFile = templateFileName('act', repKey);
  const contractPlaceholders = await scanTemplatePlaceholders(path.join(TEMPLATES_DIR, contractFile));
  const actPlaceholders = await scanTemplatePlaceholders(path.join(TEMPLATES_DIR, actFile));
  const contractInfo = getTemplateInfo(contractFile, 'dogovir', repKey);
  const actInfo = getTemplateInfo(actFile, 'akt', repKey);
  res.json({ mapping, contractPlaceholders, actPlaceholders, contractFile, actFile, contractInfo, actInfo });
});
router.put('/mapping', auth, adminOnly, (req, res) => {
  const repKey = (req.query.repKey || '').trim() || null;
  setMapping(req.body, repKey);
  res.json({ ok: true });
});

// ── Admin: template upload ───────────────────────────────────────
// ?repKey=xxx uploads a representative-specific template instead of the
// shared default — used when a ФОП needs their own contract/act wording.
router.post('/template/:type', auth, adminOnly, upload.single('file'), (req, res) => {
  const { type } = req.params;
  const repKey = (req.query.repKey || '').trim();
  if (!['contract', 'act'].includes(type)) return res.status(400).json({ error: 'Невідомий тип шаблону' });
  if (!req.file) return res.status(400).json({ error: 'Файл не завантажено' });
  const base = type === 'contract' ? 'dogovir' : 'akt';
  const fileName = repKey ? `${base}_${repKey}.docx` : `${base}.docx`;
  if (!fs.existsSync(TEMPLATES_DIR)) fs.mkdirSync(TEMPLATES_DIR, { recursive: true });
  fs.writeFileSync(path.join(TEMPLATES_DIR, fileName), req.file.buffer);
  // The uploaded file gets renamed to a fixed name on disk (dogovir.docx
  // etc.) so the original filename would otherwise be lost entirely —
  // store it (plus who/when) so the admin can tell which version is live.
  const infoKey = 'template_info_' + base + '_' + (repKey || 'default');
  // multer/busboy often hands back the filename mis-decoded as latin1 when
  // it's actually UTF-8 (multipart/form-data doesn't strictly define an
  // encoding) — re-interpret the raw bytes correctly, otherwise non-Latin
  // filenames (Ukrainian, etc.) show up as mojibake.
  const fixedOriginalName = Buffer.from(req.file.originalname, 'latin1').toString('utf8');
  const info = { originalName: fixedOriginalName, uploadedAt: new Date().toISOString(), uploadedBy: req.user?.name || req.user?.username || '' };
  const existing = db.prepare('SELECT key FROM settings WHERE key = ?').get(infoKey);
  if (existing) db.prepare('UPDATE settings SET value = ?, updated_at = datetime(\'now\') WHERE key = ?').run(JSON.stringify(info), infoKey);
  else db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run(infoKey, JSON.stringify(info));
  res.json({ ok: true, info });
});
// DELETE a representative-specific template, reverting that rep back to the shared default
router.delete('/template/:type', auth, adminOnly, (req, res) => {
  const { type } = req.params;
  const repKey = (req.query.repKey || '').trim();
  if (!['contract', 'act'].includes(type) || !repKey) return res.status(400).json({ error: 'Невідомий тип шаблону' });
  const base = type === 'contract' ? 'dogovir' : 'akt';
  const filePath = path.join(TEMPLATES_DIR, `${base}_${repKey}.docx`);
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  const infoKey = 'template_info_' + base + '_' + repKey;
  db.prepare('DELETE FROM settings WHERE key = ?').run(infoKey);
  res.json({ ok: true });
});

// GET /api/generate-document/:bookingId/:type  (type = contract | act)
// ── Document archive ─────────────────────────────────────────────
// These specific routes must come BEFORE the generic /:bookingId/:type
// below — otherwise Express matches 'archive' as a bookingId and 'list'/
// an id as the type, which fails the contract/act check and 400s.
// GET /api/generate-document/archive/list — list all generated documents (no file data, just metadata)
router.get('/archive/list', auth, (req, res) => {
  const rows = db.prepare(`SELECT id, booking_id, doc_type, file_name, client_name, vehicle_name, vehicle_plate, generated_by, contract_number, created_at
                            FROM generated_documents ORDER BY created_at DESC`).all();
  res.json(rows);
});

// GET /api/generate-document/archive/:id — download a specific archived document
router.get('/archive/:id', auth, (req, res) => {
  const row = db.prepare('SELECT * FROM generated_documents WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Документ не знайдено' });
  const filePath = path.join(GENERATED_DOCS_DIR, row.file_path);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Файл більше не існує на диску' });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(row.file_name)}"`);
  res.sendFile(filePath);
});

// DELETE /api/generate-document/archive/:id
router.delete('/archive/:id', auth, adminOnly, (req, res) => {
  const row = db.prepare('SELECT * FROM generated_documents WHERE id = ?').get(req.params.id);
  if (row) {
    try { fs.unlinkSync(path.join(GENERATED_DOCS_DIR, row.file_path)); } catch { /* file already gone — fine */ }
  }
  db.prepare('DELETE FROM generated_documents WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

router.get('/:bookingId/:type', auth, async (req, res) => {
  const { bookingId, type } = req.params;
  if (!['contract', 'act'].includes(type)) {
    return res.status(400).json({ error: 'Невідомий тип документа' });
  }

  const ctx = getBookingContext(bookingId);
  if (!ctx) return res.status(404).json({ error: 'Замовлення не знайдено' });

  const repKey = ctx.repSlot;
  const templateFile = templateFileName(type, repKey);
  const templatePath = path.join(TEMPLATES_DIR, templateFile);
  if (!fs.existsSync(templatePath)) return res.status(404).json({ error: 'Шаблон не знайдено' });

  const contractNumber = getOrCreateContractNumber(ctx, bookingId);

  const mapping = getMapping(repKey)[type] || {};
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
    const now = new Date();
    const gk = getKyivDateParts(now);
    const genStamp = gk.dd + gk.mm + gk.yyyy + '_' + gk.hh + gk.min;
    const fileName = type === 'contract'
      ? `${contractNumber}_Договір.docx`
      : `${contractNumber}_${genStamp}_Акт.docx`; // multiple acts can share one contract number, so disambiguate by generation time

    // Archive every generated document to disk — a permanent record
    // independent of later booking edits, so "what was actually handed to
    // the client" is always retrievable even if the booking data changes
    // afterward. Stored on the filesystem (not as a DB blob) to keep the
    // database itself small and make cleanup/monitoring straightforward —
    // same pattern as the existing vehicle-documents storage.
    try {
      fs.mkdirSync(GENERATED_DOCS_DIR, { recursive: true });
      const diskName = crypto.randomBytes(16).toString('hex') + '.docx';
      fs.writeFileSync(path.join(GENERATED_DOCS_DIR, diskName), fileBuffer);
      db.prepare(`INSERT INTO generated_documents (booking_id, doc_type, file_name, file_path, client_name, vehicle_name, vehicle_plate, generated_by, contract_number)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(Number(bookingId), type, fileName, diskName, clientName, vehicleName, vehiclePlate, req.user?.name || req.user?.username || '', contractNumber);
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

module.exports = router;
