const db = require('./db');

// ── Writing entries ──────────────────────────────────────────────
// Records one entry in the activity log. `snapshot` should be the full data
// object at the time of the action — critical for 'delete' actions, since
// it's the only way to recover what was lost if something was removed by
// mistake. `details` is a short human-readable list of what exactly changed
// (see diffData). Never throws — logging failures shouldn't ever block the
// actual operation they're describing.
function logActivity({ action, entityType, entityId, summary, snapshot, userName, details, ip }) {
  try {
    db.prepare(`
      INSERT INTO activity_log (action, entity_type, entity_id, summary, snapshot, user_name, details, ip)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      action,
      entityType,
      entityId != null && Number.isFinite(Number(entityId)) ? Number(entityId) : null,
      summary || null,
      snapshot !== undefined ? JSON.stringify(snapshot) : null,
      userName || null,
      details && details.length ? JSON.stringify(details) : null,
      ip || null
    );
  } catch (err) {
    console.error('Failed to write activity log entry (continuing anyway):', err);
  }
}

function reqUserName(req) {
  return req?.user?.name || req?.user?.username || null;
}
function reqIp(req) {
  try {
    return (req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '').toString().split(',')[0].trim() || null;
  } catch (e) { return null; }
}

// Shortcut for route handlers: fills in the user name and IP from the request.
function logReq(req, entry) {
  try {
    logActivity({ ...entry, userName: entry.userName || reqUserName(req), ip: entry.ip || reqIp(req) });
  } catch (err) {
    console.error('logReq failed (continuing anyway):', err);
  }
}

// ── Human-readable lookups ───────────────────────────────────────
function vehicleLabel(id) {
  try {
    const v = db.prepare('SELECT service_data FROM vehicles WHERE id = ?').get(Number(id));
    if (v) {
      const d = JSON.parse(v.service_data);
      return [d.plate, d.name].filter(Boolean).join(' · ');
    }
  } catch (e) { /* fall through */ }
  return id != null ? `авто №${id}` : '';
}
function clientLabel(id) {
  try {
    const c = db.prepare('SELECT data FROM clients WHERE id = ?').get(Number(id));
    if (c) {
      const d = JSON.parse(c.data);
      return (d.category && d.category !== 'individual') ? (d.companyName || d.name || '') : (d.name || '');
    }
  } catch (e) { /* fall through */ }
  return id != null ? `клієнт №${id}` : '';
}

const VEHICLE_DOC_LABELS = {
  tech_passport: 'Техпаспорт', owner_passport: 'Паспорт власника', trusted_passport: 'Паспорт довіреної особи',
  poa_owner: 'Довіреність від власника', poa_company: 'Довіреність на компанію', agency_contract: 'Агентський договір',
  insurance: 'Страховка', osago: 'ОСЦПВ', kasko: 'КАСКО', photos: 'Фото',
};
const CLIENT_DOC_LABELS = { passport: 'Паспорт', inn: 'ІПН', license: 'Водійське', other: 'Інше' };

// ── Field labels used by the change lists ────────────────────────
const BOOKING_LABELS = {
  vehicleId: 'Авто', status: 'Статус', closed: 'Замовлення закрито', start: 'Початок', end: 'Кінець',
  clientType: 'Тип клієнта', orderCompany: 'Компанія',
  customer: 'Клієнт', 'customer.name': 'Клієнт (ПІБ)', 'customer.phone': 'Телефон', 'customer.company': 'Компанія клієнта',
  'customer.edrpou': 'ЄДРПОУ', 'customer.clientId': 'Картка клієнта',
  vatRate: 'ПДВ, %', hasVatExempt: 'Без ПДВ', baseRateExcel: 'Базова ціна (Excel)', companyPercent: 'Відсоток компанії',
  rateComment: 'Коментар до тарифу', exchangeRate: 'Курс',
  pickup: 'Видача', 'pickup.date': 'Дата видачі', 'pickup.time': 'Час видачі', 'pickup.loc': 'Місце видачі',
  ret: 'Повернення', 'ret.date': 'Дата повернення', 'ret.time': 'Час повернення', 'ret.loc': 'Місце повернення',
  extension: 'Продовження', 'extension.active': 'Продовження активне', 'extension.fromDate': 'Продовження: з',
  'extension.toDate': 'Продовження: по', 'extension.days': 'Продовження: діб', 'extension.rate': 'Продовження: тариф',
  'extension.cost': 'Продовження: вартість', 'extension.currency': 'Продовження: валюта',
  'extension.exchangeRate': 'Продовження: курс', 'extension.amountPaid': 'Продовження: сплачено',
  'extension.payments': 'Продовження: оплати',
  extensionHistory: 'Історія продовжень', substituteVehicles: 'Підмінні авто',
  rate: 'Тариф', currency: 'Валюта', deposit: 'Застава', depositCur: 'Валюта застави',
  payMethod: 'Спосіб оплати', partialPaymentActive: 'Часткова оплата', amountPaid: 'Сплачено',
  payments: 'Оплати', depositPayMethod: 'Спосіб оплати застави', depositMixedNote: 'Примітка до застави',
  daysOverride: 'Кількість діб', earlyReturn: 'Дострокове повернення', discount: 'Знижка',
  startKm: 'Пробіг на початку', endKm: 'Пробіг в кінці', deductions: 'Утримання', fines: 'Штрафи',
  repairPause: 'Ремонт (пауза)', 'repairPause.fromDate': 'Ремонт: з', 'repairPause.toDate': 'Ремонт: по',
  'repairPause.reason': 'Ремонт: причина', 'repairPause.days': 'Ремонт: діб',
  extras: 'Додаткові послуги', equipment: 'Обладнання', messengers: 'Месенджери', notes: 'Нотатки',
};
const CLIENT_LABELS = {
  name: 'ПІБ', category: 'Категорія', companyName: 'Компанія', edrpou: 'ЄДРПОУ', tier: 'Рівень', phone: 'Телефон',
  extraContacts: 'Додаткові контакти', birthdate: 'Дата народження', passportNum: 'Паспорт №',
  passportIssuer: 'Паспорт: ким виданий', passportDate: 'Паспорт: дата видачі', idcardNum: 'ID-картка №',
  idcardRecord: 'ID-картка: запис', idcardDate: 'ID-картка: дата', idcardIssuer: 'ID-картка: орган',
  inn: 'ІПН', address: 'Адреса', messengers: 'Месенджери', nrCitizenship: 'Громадянство',
  nrPassportNum: 'Закордонний паспорт №', nrPassportDate: 'Закордонний паспорт: дата',
  nrPassportExpiry: 'Закордонний паспорт: діє до', notes: 'Нотатки',
};
const VEHICLE_LABELS = {
  name: 'Назва', plate: 'Номер', vin: 'VIN', category: 'Категорія', tariffClass: 'Тарифний клас',
  owner: 'Власник', 'owner.name': 'Власник (ПІБ)', 'owner.phone': 'Власник: телефон', 'owner.inn': 'Власник: ІПН',
  sts: 'Техпаспорт', 'sts.number': 'Техпаспорт №', 'sts.date': 'Техпаспорт: дата',
  specs: 'Характеристики', 'specs.brand': 'Марка', 'specs.model': 'Модель', 'specs.year': 'Рік', 'specs.color': 'Колір',
  'specs.bodyType': 'Кузов', 'specs.priceLink': 'Посилання на ціни', 'specs.priceLink2': 'Посилання на ціни 2',
  'specs.engine': 'Двигун', 'specs.power': 'Потужність', 'specs.transmission': 'КПП', 'specs.drive': 'Привід',
  'specs.fuel': 'Паливо', 'specs.consumption': 'Витрата', 'specs.climate': 'Клімат', 'specs.options': 'Опції',
  service: 'ТО', 'service.lastKm': 'ТО: останній пробіг', 'service.nextKm': 'ТО: наступний пробіг',
  'service.lastDate': 'ТО: остання дата', 'service.status': 'ТО: статус',
  currentKm: 'Пробіг', works: 'Роботи / ремонти', insurance: 'Страховка', osago: 'ОСЦПВ', kasko: 'КАСКО',
  poaExpiry: 'Довіреність: діє до', trusted: 'Довірена особа', 'trusted.name': 'Довірена особа (ПІБ)',
  'trusted.phone': 'Довірена особа: телефон', docs: 'Документи (чекліст)',
};
const STICKER_LABELS = { title: 'Заголовок', text: 'Текст', color: 'Колір', pinned: 'Закріплено', comments: 'Коментарі' };

const SKIP_KEYS = new Set(['id', '_createdAt', '_updatedAt', '_createdBy', 'createdAt', 'updatedAt', 'author', 'createdBy', 'edited', 'editedBy', 'editedAt']);

// ── Diffing ──────────────────────────────────────────────────────
const isEmpty = v => v === undefined || v === null || v === '' || v === false;
const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const clip = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

function fmtScalar(v) {
  if (isEmpty(v)) return '—';
  if (v === true) return 'так';
  return clip(String(v), 160);
}
// One list item in a short readable form: scalars as-is, objects as "k: v, k: v".
function fmtItem(it, labels, pathPrefix) {
  if (!isObj(it)) return fmtScalar(it);
  const parts = [];
  for (const [k, v] of Object.entries(it)) {
    if (SKIP_KEYS.has(k) || isEmpty(v) || isObj(v) || Array.isArray(v)) continue;
    const lab = labels[pathPrefix + '.' + k] || labels[k] || k;
    parts.push(`${lab}: ${fmtScalar(v)}`);
    if (parts.length >= 6) break;
  }
  return parts.length ? parts.join(', ') : clip(JSON.stringify(it), 120);
}

const MAX_CHANGES = 60;

function diffCore(before, after, labels = {}, path = '', out = []) {
  const b = isObj(before) ? before : {};
  const a = isObj(after) ? after : {};
  const keys = new Set([...Object.keys(b), ...Object.keys(a)]);
  for (const k of keys) {
    if (SKIP_KEYS.has(k) || out.length >= MAX_CHANGES) continue;
    const p = path ? path + '.' + k : k;
    const label = labels[p] || labels[k] || p;
    const bv = b[k], av = a[k];

    if (Array.isArray(bv) || Array.isArray(av)) {
      const ba = Array.isArray(bv) ? bv : [], aa = Array.isArray(av) ? av : [];
      const bs = ba.map(x => JSON.stringify(x)), as = aa.map(x => JSON.stringify(x));
      if (JSON.stringify(ba) === JSON.stringify(aa)) continue;
      const removed = ba.filter((x, i) => !as.includes(bs[i]));
      const added = aa.filter((x, i) => !bs.includes(as[i]));
      if (!removed.length && !added.length) {
        out.push({ label, to: 'змінено порядок' });
        continue;
      }
      out.push({
        label,
        removed: removed.slice(0, 6).map(x => fmtItem(x, labels, p)).concat(removed.length > 6 ? [`… ще ${removed.length - 6}`] : []),
        added: added.slice(0, 6).map(x => fmtItem(x, labels, p)).concat(added.length > 6 ? [`… ще ${added.length - 6}`] : []),
      });
      continue;
    }
    if (isObj(bv) || isObj(av)) {
      diffCore(bv, av, labels, p, out);
      continue;
    }
    // scalars
    if (isEmpty(bv) && isEmpty(av)) continue;
    if (String(bv ?? '') === String(av ?? '')) continue;
    if (k === 'notes' && typeof av === 'string' && typeof bv === 'string' && bv && av.startsWith(bv)) {
      out.push({ label, from: null, to: 'додано: ' + clip(av.slice(bv.length).trim(), 200) });
      continue;
    }
    out.push({ label, from: fmtScalar(bv), to: fmtScalar(av) });
  }
  return out;
}

// Never throws: if comparing fails for any reason the change list is just empty.
function diffData(before, after, labels) {
  try { return diffCore(before, after, labels || {}); } catch (e) { console.error('diffData failed:', e); return []; }
}

// "Статус, Тариф, Пробіг (+2)" — a short list of what changed, for the row title.
function changedLabels(changes, max = 4) {
  if (!Array.isArray(changes)) return '';
  const names = [...new Set(changes.map(c => c.label))];
  const shown = names.slice(0, max).join(', ');
  return names.length > max ? `${shown} (+${names.length - max})` : shown;
}

// Replace raw values (ids, status keys) in a change list by readable ones.
function mapValues(changes, label, fn) {
  changes.forEach(c => {
    if (c.label !== label) return;
    if (c.from != null) c.from = fn(c.from);
    if (c.to != null) c.to = fn(c.to);
  });
  return changes;
}
const STATUS_LABELS = {
  rented: 'В оренді', extension: 'Пролонгація без $', 'res-docs': 'Резерв + документи', reserved: 'Резерв',
  repair: 'В ремонті', investor: 'У Інвестора', storage: 'На зберіганні', personal: 'Особисте використання',
  substitute: 'Підмінне авто',
};
const PAY_LABELS = { cash: 'готівка', card: 'картка', mixed: 'змішана' };

module.exports = {
  mapValues, STATUS_LABELS, PAY_LABELS,
  logActivity, logReq, reqUserName, reqIp,
  vehicleLabel, clientLabel,
  VEHICLE_DOC_LABELS, CLIENT_DOC_LABELS,
  BOOKING_LABELS, CLIENT_LABELS, VEHICLE_LABELS, STICKER_LABELS,
  diffData, changedLabels,
};
