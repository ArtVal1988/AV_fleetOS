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
function vehicleDocLabel(key) {
  if (VEHICLE_DOC_LABELS[key]) return VEHICLE_DOC_LABELS[key];
  const m = /^work_(\d+)$/.exec(String(key));
  return m ? `Файл до роботи ТО №${m[1]}` : key;
}
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
  payMethod: 'Спосіб оплати', payMixedNote: 'Примітка до змішаної оплати', partialPaymentActive: 'Часткова оплата', amountPaid: 'Сплачено',
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

// Maintenance (ТО) works, stored in vehicle.works
const WORK_TYPE_LABELS = { planned: 'Планове ТО', unplanned: 'Позапланове / Ремонт', parts_purchase: 'Закупка запчастин' };
const WORK_STATUS_LABELS = { done: 'виконано', planned: 'заплановано' };
const WORK_LABELS = {
  type: 'Тип', status: 'Статус', name: 'Назва', desc: 'Опис', date: 'Дата', mileage: 'Пробіг, км',
  labor: 'Вартість робіт', garage: 'СТО / майстер', materials: 'Запчастини',
  qty: 'к-сть', partNumber: 'артикул', price: 'ціна',
};
const CASE_LABELS = {
  date: 'Дата', policy: 'Поліс', category: 'Категорія', status: 'Статус', title: 'Назва', description: 'Опис',
  damageAmount: 'Збиток', deductible: 'Франшиза', payoutAmount: 'Виплата',
};
const POLICY_LABELS = {
  insurer: 'Страховик', policyNum: 'Поліс №', contractDate: 'Дата договору', start: 'Початок', end: 'Діє до',
  insuredSum: 'Страхова сума', tariff: 'Тариф', paymentType: 'Тип оплати', totalPremium: 'Премія',
  deductiblePct: 'Франшиза, %', deductible: 'Франшиза', notes: 'Нотатки', reqRecipient: 'Отримувач платежу',
  reqCode: 'Код отримувача', reqAccount: 'Рахунок', reqPurpose: 'Призначення платежу', payments: 'Платежі',
};
for (const [pol, name] of [['osago', 'ОСЦПВ'], ['kasko', 'КАСКО'], ['insurance', 'Страховка']]) {
  for (const [k, lab] of Object.entries(POLICY_LABELS)) VEHICLE_LABELS[`${pol}.${k}`] = `${name}: ${lab}`;
}
Object.assign(VEHICLE_LABELS, {
  serviceInterval: 'Інтервал ТО, км', 'service.interval': 'Інтервал ТО, км',
  insuranceCases: 'Страхові випадки', 'trusted.passport': 'Довірена особа: паспорт', 'trusted.inn': 'Довірена особа: ІПН',
  mileageNote: 'Примітка до пробігу',
});

// Arrays whose items have an `id`: compared item by item instead of as a blob.
const BY_ID = {
  works: {
    noun: 'ТО / ремонт', itemLabels: WORK_LABELS,
    title: w => w.name || 'без назви',
    describe: w => {
      const parts = [w.name || 'без назви', WORK_TYPE_LABELS[w.type] || w.type, w.date, w.mileage ? `${w.mileage} км` : null,
        w.labor ? `робота: ${w.labor}` : null, w.garage ? `СТО: ${w.garage}` : null,
        (w.materials && w.materials.length) ? 'запчастини: ' + w.materials.map(m => `${m.name}${m.qty ? ' ×' + m.qty : ''}`).join(', ') : null];
      return parts.filter(Boolean).join(' · ');
    },
    valueMaps: { 'Тип': v => WORK_TYPE_LABELS[v] || v, 'Статус': v => WORK_STATUS_LABELS[v] || v },
  },
  insuranceCases: {
    noun: 'Страховий випадок', itemLabels: CASE_LABELS, skip: ['files'],
    title: c => c.title || c.category || c.date || 'без назви',
    describe: c => [c.date, c.title, c.category, c.status ? `статус: ${c.status}` : null,
      c.damageAmount ? `збиток: ${c.damageAmount}` : null, c.payoutAmount ? `виплата: ${c.payoutAmount}` : null].filter(Boolean).join(' · '),
  },
};
// Derived / cosmetic fields that change automatically or are not a user's real edit.
const SKIP_PATHS = new Set(['nextServiceKm', 'service.nextKm', 'service.status', 'currentKmDate', 'sortOrder',
  'categoryOrder', 'categoryColor', 'docs.activeFile', 'docs.missingCount']);

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

// Item-by-item diff for arrays of records with an id. Returns false when the
// items have no ids (caller then falls back to the generic list comparison).
function diffById(ba, aa, cfg, out) {
  const ok = arr => arr.every(x => isObj(x) && x.id != null);
  if (!ok(ba) || !ok(aa)) return false;
  const clean = it => { if (!cfg.skip) return it; const c = { ...it }; cfg.skip.forEach(k => delete c[k]); return c; };
  const bm = new Map(ba.map(x => [String(x.id), x])), am = new Map(aa.map(x => [String(x.id), x]));
  for (const [id, it] of am) {
    if (out.length >= MAX_CHANGES) break;
    const old = bm.get(id);
    if (!old) { out.push({ label: `${cfg.noun}: додано`, to: cfg.describe(it) }); continue; }
    if (JSON.stringify(clean(old)) === JSON.stringify(clean(it))) continue;
    const sub = diffCore(clean(old), clean(it), cfg.itemLabels, '', []);
    for (const [lab, fn] of Object.entries(cfg.valueMaps || {})) mapValues(sub, lab, fn);
    sub.forEach(c => out.push({ ...c, label: `${cfg.noun} «${cfg.title(it)}»: ${c.label}` }));
  }
  for (const [id, it] of bm) {
    if (!am.has(id) && out.length < MAX_CHANGES) out.push({ label: `${cfg.noun}: видалено`, to: cfg.describe(it) });
  }
  return true;
}

function diffCore(before, after, labels = {}, path = '', out = []) {
  const b = isObj(before) ? before : {};
  const a = isObj(after) ? after : {};
  const keys = new Set([...Object.keys(b), ...Object.keys(a)]);
  for (const k of keys) {
    if (SKIP_KEYS.has(k) || out.length >= MAX_CHANGES) continue;
    const p = path ? path + '.' + k : k;
    if (labels.__vehicle && SKIP_PATHS.has(p)) continue;
    const label = labels[p] || labels[k] || p;
    const bv = b[k], av = a[k];

    if (Array.isArray(bv) || Array.isArray(av)) {
      const ba = Array.isArray(bv) ? bv : [], aa = Array.isArray(av) ? av : [];
      if (labels.__vehicle && BY_ID[p] && diffById(ba, aa, BY_ID[p], out)) continue;
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
  rented: 'В оренді', extension: 'Пролонгація без $', returned: 'Повернено з оренди', 'res-docs': 'Резерв + документи', reserved: 'Резерв',
  repair: 'В ремонті', investor: 'У Інвестора', storage: 'На зберіганні', personal: 'Особисте використання',
  substitute: 'Підмінне авто',
};
const PAY_LABELS = { cash: 'готівка', card: 'картка', mixed: 'змішана' };


// ── One-time backfill ────────────────────────────────────────────
// Entries written before the detailed log existed only have a before/after
// snapshot. Rebuild readable details (and the «Ремонти і ТО» / «Страхування»
// sections) from those snapshots, once, so older work shows up properly too.
const MAINT_KEYS = ['works', 'service', 'serviceInterval', 'currentKm', 'nextServiceKm', 'currentKmDate'];
const INSUR_KEYS = ['insuranceCases', 'osago', 'kasko', 'insurance'];
function pickKeys(o, keys, invert) {
  const r = {};
  Object.keys(o || {}).forEach(k => { if (keys.includes(k) !== !!invert) r[k] = o[k]; });
  return r;
}

function backfillActivityLog() {
  try {
    const done = db.prepare("SELECT value FROM settings WHERE key = 'activity_log_backfill_v1'").get();
    if (done) return;
    const rows = db.prepare(`SELECT id, action, entity_type, summary, snapshot FROM activity_log
      WHERE details IS NULL AND action = 'update' AND snapshot IS NOT NULL
        AND entity_type IN ('vehicle','client','booking','sticker')`).all();
    const upd = db.prepare('UPDATE activity_log SET details = ?, summary = ?, entity_type = ? WHERE id = ?');
    let n = 0;
    for (const r of rows) {
      let snap;
      try { snap = JSON.parse(r.snapshot); } catch (e) { continue; }
      if (!snap || !snap.before || !snap.after) continue;
      let changes = [], type = r.entity_type, summary = r.summary || '';
      if (r.entity_type === 'vehicle') {
        const parts = [
          ['maintenance', MAINT_KEYS, false], ['insurance', INSUR_KEYS, false],
          ['vehicle', [...MAINT_KEYS, ...INSUR_KEYS], true],
        ].map(([t, keys, inv]) => ({ t, ch: diffData(pickKeys(snap.before, keys, inv), pickKeys(snap.after, keys, inv), VEHICLE_DIFF_LABELS_REF.v) }))
          .filter(x => x.ch.length);
        if (!parts.length) continue;
        changes = parts.flatMap(x => x.ch);
        if (parts.length === 1) type = parts[0].t;
        const plate = snap.after.plate || snap.before.plate || '';
        summary = `${plate ? plate + ' — ' : ''}${changedLabels(changes)}`;
      } else if (r.entity_type === 'client') {
        changes = diffData(snap.before, snap.after, CLIENT_LABELS);
        if (changes.length) summary = `${summary.split(' — ')[0]} — ${changedLabels(changes)}`;
      } else if (r.entity_type === 'sticker') {
        changes = diffData(snap.before, snap.after, STICKER_LABELS);
        if (changes.length) summary = `${summary.split(' — ')[0]} — ${changedLabels(changes)}`;
      } else if (r.entity_type === 'booking') {
        changes = diffData(snap.before, snap.after, BOOKING_LABELS);
        mapValues(changes, 'Авто', v => vehicleLabel(v));
        mapValues(changes, 'Статус', v => STATUS_LABELS[v] || v);
        mapValues(changes, 'Спосіб оплати', v => PAY_LABELS[v] || v);
        if (changes.length) summary = `${summary.split(' — ')[0]} — ${changedLabels(changes)}`;
      }
      if (!changes.length) continue;
      upd.run(JSON.stringify(changes), summary, type, r.id);
      n++;
    }
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('activity_log_backfill_v1', ?)").run(JSON.stringify({ at: new Date().toISOString(), updated: n }));
    if (n) console.log(`[activity-log] backfilled details for ${n} older entries`);
  } catch (e) {
    console.error('Activity log backfill failed (continuing anyway):', e);
  }
}

const VEHICLE_DIFF_LABELS_REF = { v: Object.assign({}, VEHICLE_LABELS, { __vehicle: true }) };
module.exports = {
  backfillActivityLog,
  VEHICLE_DIFF_LABELS: Object.assign({}, VEHICLE_LABELS, { __vehicle: true }),
  mapValues, STATUS_LABELS, PAY_LABELS,
  logActivity, logReq, reqUserName, reqIp,
  vehicleLabel, clientLabel,
  VEHICLE_DOC_LABELS, CLIENT_DOC_LABELS, vehicleDocLabel,
  BOOKING_LABELS, CLIENT_LABELS, VEHICLE_LABELS, STICKER_LABELS,
  diffData, changedLabels,
};
