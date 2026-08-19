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

// ── Document types per ФОП slot ──────────────────────────────────
// Individual clients only ever need a simple contract+act; the two
// business slots (з/без ПДВ) additionally need invoices and a deposit
// letter. Same type KEYS are reused across business_no_vat/business_vat —
// the slot (repKey) already namespaces the actual template files, so no
// need for separate keys, just different labels for the ПДВ-prefixed ones.
const DOCUMENT_TYPES = {
  individual: [
    { key: 'contract', label: 'Договір' },
    { key: 'act', label: 'Акт' },
    { key: 'act_extension', label: 'Акт_продовження' },
  ],
  nonresident: [
    { key: 'contract', label: 'Нерезидент - Договір' },
    { key: 'act', label: 'Нерезидент - Акт' },
    { key: 'act_extension', label: 'Нерезидент - Акт_продовження' },
  ],
  business_no_vat: [
    { key: 'contract', label: 'Договір' },
    { key: 'act', label: 'Акт_приймання-передачі' },
    { key: 'act_extension', label: 'Акт_продовження' },
    { key: 'invoice_rent', label: 'Рахунок_оренда' },
    { key: 'invoice_deposit', label: 'Рахунок_застава' },
    { key: 'deposit_letter', label: 'Лист_про_зарахування_застави' },
    { key: 'service_act', label: 'Акт_надання_послуг' },
  ],
  business_vat: [
    { key: 'contract', label: 'ПДВ - Договір' },
    { key: 'act', label: 'ПДВ - Акт_приймання-передачі' },
    { key: 'act_extension', label: 'ПДВ - Акт_продовження' },
    { key: 'invoice_rent', label: 'ПДВ - Рахунок_оренда' },
    { key: 'invoice_deposit', label: 'ПДВ - Рахунок_застава' },
    { key: 'deposit_letter', label: 'ПДВ - Лист_про_зарахування_застави' },
    { key: 'service_act', label: 'ПДВ - Акт_надання_послуг' },
  ],
};
const ALL_DOC_TYPE_KEYS = ['contract', 'act', 'act_extension', 'invoice_rent', 'invoice_deposit', 'deposit_letter', 'service_act'];
function docTypeLabel(repKey, type) {
  const entry = (DOCUMENT_TYPES[repKey] || DOCUMENT_TYPES.business_no_vat).find(t => t.key === type);
  return entry ? entry.label : type;
}

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
const EN_MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
function fmtDateEnFull(iso) {
  if (!iso) return '';
  const [y, m, d] = iso.split('-');
  return `${parseInt(d)} ${EN_MONTHS[parseInt(m)-1]} ${y}`;
}
function fmtMoney(n) {
  if (n === null || n === undefined || n === '') return '';
  return Number(n).toLocaleString('uk-UA', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
// Extra services (pickup/return address delivery, off-hours) store their
// price alongside a cur mode: 'orig' means the price is always entered in
// $ (fixed, regardless of the booking's own currency), 'uah' means always
// ₴ — matching getExtrasTotalsSplit() on the frontend, the logic that
// actually drives the visible extras total in the booking form. Convert
// into the booking's own currency here, since that's what the document
// should show (e.g. a $20 fee on a ₴ booking becomes 900 ₴ at that
// booking's own exchange rate, not '20 $' left unconverted).
function getExtraFee(booking, key) {
  const e = booking.extras?.[key];
  if (!e || !e.active || !e.price) return null;
  const rawAmount = e.price * (e.qty || 1);
  const rawCurrency = e.cur === 'uah' ? '₴' : '$';
  const bookingCurrency = booking.currency || '$';
  const exRate = Number(booking.exchangeRate) || 0;
  if (rawCurrency === bookingCurrency) {
    return { amount: rawAmount, currency: bookingCurrency };
  }
  if (bookingCurrency === '₴') {
    // rawCurrency is $ — convert to ₴ by multiplying by the booking's own rate
    return { amount: exRate > 0 ? Math.round(rawAmount * exRate * 100) / 100 : rawAmount, currency: '₴' };
  }
  // bookingCurrency is $, rawCurrency is ₴ — convert to $ by dividing
  return { amount: exRate > 0 ? Math.round(rawAmount / exRate * 100) / 100 : rawAmount, currency: bookingCurrency };
}
// Extra services (Отримання/Повернення за адресою, неробочі години) — sum
// every active one, already converted into the booking's own currency by
// getExtraFee(), so this can be added on top of the base rental cost.
function getExtrasTotal(booking) {
  const keys = ['pickup_address', 'pickup_offhours', 'return_address', 'return_offhours'];
  let total = 0;
  keys.forEach(k => {
    const f = getExtraFee(booking, k);
    if (f) total += f.amount;
  });
  return total;
}
// Convert a {amount, currency} pair into ₴ using the booking's own
// exchange rate, regardless of which currency it's already in — for
// document templates (like acts) that need every amount consistently in
// UAH no matter what currency the booking itself was priced in. Returns
// null if a conversion is genuinely needed but no exchange rate exists.
function toUahAlways(feeInfo, booking) {
  if (feeInfo.currency === '₴') return Math.round(feeInfo.amount * 100) / 100;
  const exRate = Number(booking.exchangeRate) || 0;
  if (exRate <= 0) return null;
  return Math.round(feeInfo.amount * exRate * 100) / 100;
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
// Analogous to buildClientLegalDescription(), for non-resident clients —
// citizenship + foreign passport fields instead of the Ukrainian passport.
function buildClientLegalDescriptionNonresident(client, fallbackName) {
  if (!client) return fallbackName || '';
  const parts = [client.name || fallbackName || ''];
  if (client.birthdate) parts[0] += `, ${fmtDateUk(client.birthdate)} року народження`;
  if (client.nrCitizenship) parts.push(`Громадянин(ка) ${client.nrCitizenship}`);
  const passportBits = [];
  if (client.nrPassportNum) passportBits.push(`Паспорт №${client.nrPassportNum}`);
  if (client.nrPassportDate) passportBits.push(`виданий ${fmtDateUk(client.nrPassportDate)} року`);
  if (client.nrPassportExpiry) passportBits.push(`дійсний до ${fmtDateUk(client.nrPassportExpiry)} року`);
  if (passportBits.length) parts.push(passportBits.join(', '));
  return parts.join('. ');
}
function countDays(start, end) {
  const s = new Date(start), e = new Date(end);
  return Math.max(1, Math.round((e - s) / 86400000));
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
  { key: 'client_legal_nonresident', label: 'Клієнт повний опис (нерезидент — громадянство, закордонний паспорт)', get: ctx => buildClientLegalDescriptionNonresident(ctx.client, ctx.booking.customer?.name) },
  { key: 'client_nr_citizenship', label: 'Клієнт (нерезидент): громадянство', get: ctx => ctx.client?.nrCitizenship || '' },
  { key: 'client_nr_passport_num', label: 'Клієнт (нерезидент): номер закордонного паспорта', get: ctx => ctx.client?.nrPassportNum || '' },
  { key: 'client_nr_passport_date', label: 'Клієнт (нерезидент): дата видачі паспорта', get: ctx => fmtDateUk(ctx.client?.nrPassportDate) },
  { key: 'client_nr_passport_expiry', label: 'Клієнт (нерезидент): паспорт дійсний до', get: ctx => fmtDateUk(ctx.client?.nrPassportExpiry) },
  { key: 'client_inn', label: 'Клієнт: ІПН', get: ctx => ctx.client?.inn || ctx.booking.customer?.edrpou || '' },
  { key: 'client_address', label: 'Клієнт: адреса реєстрації', get: ctx => ctx.client?.address || '' },
  { key: 'client_license_num', label: 'Клієнт: номер посвідчення водія', get: ctx => ctx.client?.licenseNum || '' },
  { key: 'client_license_cat', label: 'Клієнт: категорія посвідчення', get: ctx => ctx.client?.licenseCat || '' },
  { key: 'company_name', label: 'Компанія-наймач (юрособа), якщо є', get: ctx => ctx.booking.customer?.company || '' },
  { key: 'rental_start', label: 'Дата отримання авто', get: ctx => fmtDateUk(ctx.booking.start) },
  { key: 'rental_start_text', label: 'Дата отримання авто текстом ("26 липня 2026 року")', get: ctx => fmtDateUkFull(ctx.booking.start) },
  { key: 'rental_start_text_en', label: 'Дата отримання авто текстом англійською ("26 July 2026")', get: ctx => fmtDateEnFull(ctx.booking.start) },
  { key: 'rental_end', label: 'Дата повернення авто', get: ctx => fmtDateUk(ctx.booking.end) },
  { key: 'rental_days', label: 'Кількість діб оренди', get: ctx => String(ctx.booking.daysOverride > 0 ? ctx.booking.daysOverride : countDays(ctx.booking.start, ctx.booking.end)) },
  { key: 'pickup_time', label: 'Час отримання', get: ctx => ctx.booking.pickup?.time || '' },
  { key: 'pickup_address', label: 'Адреса отримання', get: ctx => ctx.booking.pickup?.loc || 'Офіс, вул. Антоновича, 112' },
  { key: 'return_time', label: 'Час повернення', get: ctx => ctx.booking.ret?.time || '' },
  { key: 'return_address', label: 'Адреса повернення', get: ctx => ctx.booking.ret?.loc || 'Офіс, вул. Антоновича, 112' },
  { key: 'pickup_address_fee', label: 'Тариф «Отримання за адресою»', get: ctx => {
    const f = getExtraFee(ctx.booking, 'pickup_address');
    return f ? `${fmtMoney(f.amount)} ${f.currency}` : '';
  } },
  { key: 'pickup_address_fee_uah', label: 'Тариф «Отримання за адресою» в грн (завжди конвертовано в грн)', get: ctx => {
    const f = getExtraFee(ctx.booking, 'pickup_address');
    if (!f) return '';
    const uah = toUahAlways(f, ctx.booking);
    return uah !== null ? fmtMoney(uah) : '';
  } },
  { key: 'return_address_fee', label: 'Тариф «Повернення за адресою»', get: ctx => {
    const f = getExtraFee(ctx.booking, 'return_address');
    return f ? `${fmtMoney(f.amount)} ${f.currency}` : '';
  } },
  { key: 'return_address_fee_uah', label: 'Тариф «Повернення за адресою» в грн (завжди конвертовано в грн)', get: ctx => {
    const f = getExtraFee(ctx.booking, 'return_address');
    if (!f) return '';
    const uah = toUahAlways(f, ctx.booking);
    return uah !== null ? fmtMoney(uah) : '';
  } },
  { key: 'offhours_total_fee', label: 'Тариф «Загальний за неробочі години» (отримання + повернення)', get: ctx => {
    const pickup = getExtraFee(ctx.booking, 'pickup_offhours');
    const ret = getExtraFee(ctx.booking, 'return_offhours');
    if (!pickup && !ret) return '';
    // Both fees are normally in the same currency (both derive from the
    // same booking) — if they somehow differ, show them separately rather
    // than silently adding mismatched currencies together.
    if (pickup && ret && pickup.currency === ret.currency) {
      return `${fmtMoney(pickup.amount + ret.amount)} ${pickup.currency}`;
    }
    const parts = [pickup, ret].filter(Boolean).map(f => `${fmtMoney(f.amount)} ${f.currency}`);
    return parts.join(' + ');
  } },
  { key: 'offhours_total_fee_uah', label: 'Тариф «Загальний за неробочі години» в грн (завжди конвертовано в грн)', get: ctx => {
    const pickup = getExtraFee(ctx.booking, 'pickup_offhours');
    const ret = getExtraFee(ctx.booking, 'return_offhours');
    if (!pickup && !ret) return '';
    const pickupUah = pickup ? toUahAlways(pickup, ctx.booking) : 0;
    const retUah = ret ? toUahAlways(ret, ctx.booking) : 0;
    if (pickupUah === null || retUah === null) return '';
    return fmtMoney(pickupUah + retUah);
  } },
  { key: 'rate_per_day', label: 'Тариф за добу (з валютою і еквівалентом в $)', get: ctx => {
    const rate = ctx.booking.rate;
    if (rate === null || rate === undefined || rate === '') return '';
    const cur = ctx.booking.currency || '$';
    if (cur === '$') return `${fmtMoney(rate)} $`;
    const exRate = Number(ctx.booking.exchangeRate) || 0;
    const usd = exRate > 0 ? Math.round(rate / exRate * 100) / 100 : null;
    return `${fmtMoney(rate)} ${cur}${usd !== null ? ` (${fmtMoney(usd)} $)` : ''}`;
  } },
  { key: 'rate_per_day_uah', label: 'Тариф за добу в грн (конвертовано за курсом замовлення)', get: ctx => {
    const rate = ctx.booking.rate;
    if (rate === null || rate === undefined || rate === '') return '';
    const isUsd = ctx.booking.currency === '$';
    // If the rate itself is already in ₴, no conversion needed. If it's in
    // $, multiply by the booking's own exchange rate — that's the rate
    // this specific rental actually used, not some separate/global one.
    const uah = isUsd ? rate * (Number(ctx.booking.exchangeRate) || 0) : rate;
    return fmtMoney(Math.round(uah * 100) / 100);
  } },
  { key: 'rate_per_day_usd', label: 'Тариф за добу в долл (конвертовано за курсом замовлення)', get: ctx => {
    const rate = ctx.booking.rate;
    if (rate === null || rate === undefined || rate === '') return '';
    const isUah = ctx.booking.currency === '₴';
    // If the rate is already in $, no conversion needed. If it's in ₴,
    // divide by the booking's own exchange rate.
    const exRate = Number(ctx.booking.exchangeRate) || 0;
    const usd = isUah ? (exRate > 0 ? rate / exRate : 0) : rate;
    return fmtMoney(Math.round(usd * 100) / 100);
  } },
  { key: 'currency', label: 'Валюта замовлення', get: ctx => ctx.booking.currency || '' },
  { key: 'total_amount', label: 'Загальна вартість оренди + додаткові послуги (з валютою і еквівалентом в $)', get: ctx => {
    const days = ctx.booking.daysOverride > 0 ? ctx.booking.daysOverride : countDays(ctx.booking.start, ctx.booking.end);
    const total = (ctx.booking.rate||0) * days + getExtrasTotal(ctx.booking);
    const cur = ctx.booking.currency || '$';
    if (cur === '$') return `${fmtMoney(total)} $`;
    const exRate = Number(ctx.booking.exchangeRate) || 0;
    const usd = exRate > 0 ? Math.round(total / exRate * 100) / 100 : null;
    return `${fmtMoney(total)} ${cur}${usd !== null ? ` (${fmtMoney(usd)} $)` : ''}`;
  } },
  { key: 'total_amount_uah', label: 'Загальна вартість оренди + додаткові послуги в грн (конвертовано за курсом замовлення)', get: ctx => {
    const days = ctx.booking.daysOverride > 0 ? ctx.booking.daysOverride : countDays(ctx.booking.start, ctx.booking.end);
    const total = (ctx.booking.rate||0) * days + getExtrasTotal(ctx.booking);
    const isUsd = ctx.booking.currency === '$';
    const uah = isUsd ? total * (Number(ctx.booking.exchangeRate) || 0) : total;
    return fmtMoney(Math.round(uah * 100) / 100);
  } },
  { key: 'amount_paid', label: 'Оплачено — сума всіх внесених платежів (з валютою і еквівалентом в $)', get: ctx => {
    const paid = Number(ctx.booking.amountPaid) || 0;
    const cur = ctx.booking.currency || '$';
    if (cur === '$') return `${fmtMoney(paid)} $`;
    const exRate = Number(ctx.booking.exchangeRate) || 0;
    const usd = exRate > 0 ? Math.round(paid / exRate * 100) / 100 : null;
    return `${fmtMoney(paid)} ${cur}${usd !== null ? ` (${fmtMoney(usd)} $)` : ''}`;
  } },
  { key: 'debt_amount', label: 'Борг — залишок несплаченої суми по першочерговому періоду (з валютою і еквівалентом в $)', get: ctx => {
    const days = ctx.booking.daysOverride > 0 ? ctx.booking.daysOverride : countDays(ctx.booking.start, ctx.booking.end);
    const total = (ctx.booking.rate||0) * days + getExtrasTotal(ctx.booking);
    const paid = Number(ctx.booking.amountPaid) || 0;
    const debt = Math.max(0, Math.round((total - paid) * 100) / 100);
    const cur = ctx.booking.currency || '$';
    if (cur === '$') return `${fmtMoney(debt)} $`;
    const exRate = Number(ctx.booking.exchangeRate) || 0;
    const usd = exRate > 0 ? Math.round(debt / exRate * 100) / 100 : null;
    return `${fmtMoney(debt)} ${cur}${usd !== null ? ` (${fmtMoney(usd)} $)` : ''}`;
  } },
  { key: 'amount_paid_uah', label: 'Оплачено в грн (конвертовано за курсом замовлення)', get: ctx => {
    const paid = Number(ctx.booking.amountPaid) || 0;
    const isUsd = ctx.booking.currency === '$';
    const uah = isUsd ? paid * (Number(ctx.booking.exchangeRate) || 0) : paid;
    return fmtMoney(Math.round(uah * 100) / 100);
  } },
  { key: 'debt_amount_uah', label: 'Борг в грн (конвертовано за курсом замовлення)', get: ctx => {
    const days = ctx.booking.daysOverride > 0 ? ctx.booking.daysOverride : countDays(ctx.booking.start, ctx.booking.end);
    const total = (ctx.booking.rate||0) * days + getExtrasTotal(ctx.booking);
    const paid = Number(ctx.booking.amountPaid) || 0;
    const debt = Math.max(0, Math.round((total - paid) * 100) / 100);
    const isUsd = ctx.booking.currency === '$';
    const uah = isUsd ? debt * (Number(ctx.booking.exchangeRate) || 0) : debt;
    return fmtMoney(Math.round(uah * 100) / 100);
  } },
  { key: 'deposit', label: 'Сума застави (депозиту) (з валютою і еквівалентом в $)', get: ctx => {
    const deposit = ctx.booking.deposit;
    if (!deposit) return '';
    const cur = ctx.booking.depositCur || ctx.booking.currency || '$';
    if (cur === '$') return `${fmtMoney(deposit)} $`;
    const exRate = Number(ctx.booking.exchangeRate) || 0;
    const usd = exRate > 0 ? Math.round(deposit / exRate * 100) / 100 : null;
    return `${fmtMoney(deposit)} ${cur}${usd !== null ? ` (${fmtMoney(usd)} $)` : ''}`;
  } },
  { key: 'deposit_uah', label: 'Сума застави в грн (конвертовано за курсом замовлення)', get: ctx => {
    const deposit = ctx.booking.deposit;
    if (!deposit) return '';
    const isUsd = (ctx.booking.depositCur || ctx.booking.currency) === '$';
    const uah = isUsd ? deposit * (Number(ctx.booking.exchangeRate) || 0) : deposit;
    return fmtMoney(Math.round(uah * 100) / 100);
  } },
  { key: 'deposit_usd', label: 'Сума застави в долл (конвертовано за курсом замовлення)', get: ctx => {
    const deposit = ctx.booking.deposit;
    if (!deposit) return '';
    const isUah = (ctx.booking.depositCur || ctx.booking.currency) === '₴';
    const exRate = Number(ctx.booking.exchangeRate) || 0;
    const usd = isUah ? (exRate > 0 ? deposit / exRate : 0) : deposit;
    return fmtMoney(Math.round(usd * 100) / 100);
  } },
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

const GENERAL_VARS_KEY = 'document_general_variables';
function getGeneralVariables() {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(GENERAL_VARS_KEY);
  try { return row ? JSON.parse(row.value) : {}; } catch (e) { return {}; }
}
function getFieldValue(key, ctx) {
  if (!key) return '';
  if (key.startsWith('static:')) {
    return key.slice('static:'.length);
  }
  if (key.startsWith('path:')) {
    return resolveDataPath(key.slice('path:'.length), ctx);
  }
  if (key.startsWith('general:')) {
    const name = key.slice('general:'.length);
    const generalValue = getGeneralVariables()[name];
    if (!generalValue) return '';
    return getFieldValue(generalValue, ctx); // reuse the same static:/path:/catalog resolution
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
// Seed values used the first time a template file has no mapping of its
// own yet (byFile[file] empty) — falls back to _base, the shared layer.
const DEFAULT_MAPPING = {
  'номер': 'contract_number', 'дата': 'today_full', 'фирма1': 'vehicle_name', 'код1': 'vehicle_plate',
  'фирма2': 'client_legal', 'код2': 'client_inn', 'лицо2': 'client_name', 'адрес2': 'client_phone',
  'счет1': 'vehicle_vin', 'адрес1': 'vehicle_sts',
};
// Two-layer structure — '_base' is a shared fallback (originally the only
// layer that existed; different templates sharing the SAME #placeholder
// text used to silently overwrite each other's mapping through it, since
// there was no per-template distinction at all). 'byFile' holds per-template
// overrides, keyed by the ACTUAL resolved filename (templateFileName()'s
// result) — once a specific template has its own entry here, it no longer
// shares anything with any other template, even ones using an identical
// #placeholder name. getMappingForFile() below is the only place that
// should ever be used to resolve a real mapping for generating a document;
// getMapping()/setMapping() are kept only for the raw storage shape.
function getMappingStore() {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(MAPPING_SETTINGS_KEY);
  if (!row) return { _base: DEFAULT_MAPPING, byFile: {} };
  const parsed = JSON.parse(row.value);
  // Migrate old flat-format data (no _base/byFile split) into the new shape,
  // preserving it as the shared fallback layer so nothing already
  // configured gets silently reset to blank for every template at once.
  if (!parsed._base && !parsed.byFile) return { _base: parsed, byFile: {} };
  return { _base: parsed._base || {}, byFile: parsed.byFile || {} };
}
function getMappingForFile(file) {
  const store = getMappingStore();
  return { ...store._base, ...(store.byFile[file] || {}) };
}
function getRepresentatives() {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get('representatives');
  return row ? JSON.parse(row.value) : {};
}
// The 3 legal-form representative slots are fixed (not a free list the user
// picks from per-booking) — the slot is derived automatically from the
// booking's own client type, matching what's configured once in Налаштування.
function repSlotForClientType(clientType, residency) {
  if (residency === 'nonresident') return 'nonresident';
  if (clientType === 'individual' || !clientType) return 'individual';
  if (clientType === 'fop_no_vat') return 'business_no_vat';
  return 'business_vat'; // 'fop' or 'tov'
}
// Templates are named per-representative when a representative has their
// own uploaded template for this document type (e.g. contract_business_vat.docx)
// — falls back to the shared default (contract.docx) whenever a booking
// has no representative selected, or that representative hasn't had their
// own template uploaded yet for this specific document type.
function templateFileName(type, repKey) {
  if (repKey) {
    const named = path.join(TEMPLATES_DIR, `${type}_${repKey}.docx`);
    if (fs.existsSync(named)) return `${type}_${repKey}.docx`;
  }
  return `${type}.docx`;
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

// Word frequently splits what looks like one continuous word into multiple
// separate <w:r> (run) XML elements internally — happens from autocorrect,
// spell-check, or just editing/retyping part of a word — even though
// nothing about it looks unusual when actually looking at the document.
// When that split happens to fall inside a #placeholder token, a plain
// string search for "#placeholder" in the raw XML fails silently (the "#"
// and the rest of the name are in different elements), so the token never
// gets detected as a variable or replaced during generation. This merges
// only the specific runs needed to reveal each #placeholder within a
// paragraph, leaving every other run (and all other formatting) untouched.
function normalizeDocxRuns(xml) {
  return xml.replace(/<w:p\b[^>]*>[\s\S]*?<\/w:p>/g, paragraph => {
    const runRegex = /<w:r\b[^>]*>[\s\S]*?<\/w:r>/g;
    const runs = paragraph.match(runRegex);
    if (!runs || runs.length < 2) return paragraph;

    const runInfos = runs.map(runXml => {
      const textMatch = runXml.match(/<w:t[^>]*>([\s\S]*?)<\/w:t>/);
      return { xml: runXml, text: textMatch ? textMatch[1] : null };
    });

    let combined = '';
    const offsets = [];
    runInfos.forEach((info, i) => {
      if (info.text === null) return; // non-text run (tab/break/etc) — don't merge across it
      const start = combined.length;
      combined += info.text;
      offsets.push({ start, end: combined.length, runIndex: i });
    });

    const placeholderRegex = /#[а-яА-ЯіІїЇєЄa-zA-Z0-9_]+/g;
    let match;
    const spansToMerge = [];
    while ((match = placeholderRegex.exec(combined))) {
      const mStart = match.index, mEnd = match.index + match[0].length;
      const involved = offsets.filter(o => o.start < mEnd && o.end > mStart);
      if (involved.length > 1) {
        spansToMerge.push({ first: involved[0].runIndex, last: involved[involved.length - 1].runIndex });
      }
    }
    if (!spansToMerge.length) return paragraph;

    let mergedInfos = [...runInfos];
    spansToMerge.reverse().forEach(({ first, last }) => {
      const mergedText = mergedInfos.slice(first, last + 1).map(r => r.text || '').join('');
      const firstRunXml = mergedInfos[first].xml;
      const mergedRunXml = firstRunXml.replace(/<w:t[^>]*>[\s\S]*?<\/w:t>/, `<w:t xml:space="preserve">${mergedText}</w:t>`);
      mergedInfos.splice(first, last - first + 1, { xml: mergedRunXml, text: mergedText });
    });

    const newInner = mergedInfos.map(r => r.xml).join('');
    const firstRunPos = paragraph.indexOf(runs[0]);
    const lastRunEnd = paragraph.indexOf(runs[runs.length - 1]) + runs[runs.length - 1].length;
    return paragraph.slice(0, firstRunPos) + newInner + paragraph.slice(lastRunEnd);
  });
}

// Scan a docx template for #placeholder tokens (Cyrillic/Latin/digits)
async function scanTemplatePlaceholders(templatePath) {
  if (!fs.existsSync(templatePath)) return [];
  const buf = fs.readFileSync(templatePath);
  const zip = await JSZip.loadAsync(buf);
  const xml = normalizeDocxRuns(await zip.file('word/document.xml').async('string'));
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
  let xml = normalizeDocxRuns(await zip.file('word/document.xml').async('string'));
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

  const repSlot = repSlotForClientType(b.clientType, client?.residency);
  const reps = getRepresentatives();
  const rep = reps[repSlot] || null;

  return { booking: b, vehicle, client, rep, repSlot };
}

// ── Admin: field catalog ────────────────────────────────────────
router.get('/fields', auth, adminOnly, (req, res) => {
  res.json(FIELD_CATALOG.map(f => ({ key: f.key, label: f.label })));
});
router.get('/document-types', auth, adminOnly, (req, res) => {
  res.json(DOCUMENT_TYPES);
});

// ── Admin: mapping get/set ───────────────────────────────────────
function getTemplateInfo(actualFileName, type, repKey) {
  // actualFileName tells us whether templateFileName() resolved to the
  // rep-specific file or fell back to the shared default — look up info
  // under whichever one is actually in use, not necessarily the requested repKey.
  const isRepSpecific = repKey && actualFileName === `${type}_${repKey}.docx`;
  const infoKey = 'template_info_' + type + '_' + (isRepSpecific ? repKey : 'default');
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(infoKey);
  return row ? { ...JSON.parse(row.value), isFallback: !isRepSpecific } : null;
}
// Returns every document type for all 3 ФОП slots at once (2 for individual,
// 6 each for the two business slots), each with its scanned placeholders
// and current-file info, plus ONE deduplicated placeholder list across
// literally everything — the mapping is fully global (one #placeholder
// always means the same thing everywhere), so there's exactly one shared
// table to configure instead of a separate one per document/slot.
router.get('/mapping', auth, adminOnly, async (req, res) => {
  const removedRow = db.prepare("SELECT value FROM settings WHERE key = ?").get('document_removed_placeholders');
  const removedRaw = removedRow ? JSON.parse(removedRow.value) : {};
  const removedIsFlatArray = Array.isArray(removedRaw);
  const resolveRemovedForFile = file => removedIsFlatArray ? removedRaw : (removedRaw[file] || removedRaw._base || []);
  const store = getMappingStore();
  const needsMigration = Object.keys(store.byFile).length === 0 && Object.keys(store._base).length > 0;
  const slots = {};
  for (const repKey of Object.keys(DOCUMENT_TYPES)) {
    const templates = {};
    for (const t of DOCUMENT_TYPES[repKey]) {
      const file = templateFileName(t.key, repKey);
      const removedForFile = resolveRemovedForFile(file);
      const placeholders = (await scanTemplatePlaceholders(path.join(TEMPLATES_DIR, file))).filter(ph => !removedForFile.includes(ph));
      const info = getTemplateInfo(file, t.key, repKey);
      templates[t.key] = { label: t.label, file, placeholders, info, mapping: getMappingForFile(file), removed: removedForFile };
    }
    slots[repKey] = templates;
  }
  res.json({ slots, needsMigration, generalVariables: getGeneralVariables() });
});
router.put('/general-variables', auth, adminOnly, (req, res) => {
  const { value } = req.body;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return res.status(400).json({ error: 'Очікується об\'єкт' });
  const json = JSON.stringify(value);
  const existing = db.prepare('SELECT key FROM settings WHERE key = ?').get(GENERAL_VARS_KEY);
  if (existing) db.prepare("UPDATE settings SET value = ?, updated_at = datetime('now') WHERE key = ?").run(json, GENERAL_VARS_KEY);
  else db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run(GENERAL_VARS_KEY, json);
  res.json({ ok: true });
});
// One-time action: collect every placeholder->value mapping currently
// configured across ALL templates (every repKey+docType combination) into
// the standalone Створені змінні collection — existing created variables
// are preserved untouched, only genuinely new names get added.
router.post('/general-variables/collect-from-templates', auth, adminOnly, (req, res) => {
  const general = getGeneralVariables();
  let addedCount = 0;
  for (const repKey of Object.keys(DOCUMENT_TYPES)) {
    for (const t of DOCUMENT_TYPES[repKey]) {
      const file = templateFileName(t.key, repKey);
      const mapping = getMappingForFile(file);
      for (const [ph, val] of Object.entries(mapping)) {
        if (!val) continue;
        if (!Object.prototype.hasOwnProperty.call(general, ph)) {
          general[ph] = val;
          addedCount++;
        }
      }
    }
  }
  const json = JSON.stringify(general);
  const existing = db.prepare('SELECT key FROM settings WHERE key = ?').get(GENERAL_VARS_KEY);
  if (existing) db.prepare("UPDATE settings SET value = ?, updated_at = datetime('now') WHERE key = ?").run(json, GENERAL_VARS_KEY);
  else db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run(GENERAL_VARS_KEY, json);
  res.json({ ok: true, addedCount, generalVariables: general });
});
router.put('/mapping', auth, adminOnly, (req, res) => {
  const { file, value } = req.body;
  if (!file || typeof value !== 'object') return res.status(400).json({ error: 'Потрібні поля file та value' });
  const store = getMappingStore();
  store.byFile[file] = value;
  const json = JSON.stringify(store);
  const existing = db.prepare('SELECT key FROM settings WHERE key = ?').get(MAPPING_SETTINGS_KEY);
  if (existing) db.prepare("UPDATE settings SET value = ?, updated_at = datetime('now') WHERE key = ?").run(json, MAPPING_SETTINGS_KEY);
  else db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run(MAPPING_SETTINGS_KEY, json);
  res.json({ ok: true });
});
// Persist which scanned #placeholders the admin explicitly hid — can't
// remove the actual text from the .docx file itself, but this stops them
// from reappearing in the list every time the panel is reopened.
router.put('/mapping/removed', auth, adminOnly, (req, res) => {
  const { file, removed } = req.body;
  if (!file || !Array.isArray(removed)) return res.status(400).json({ error: 'Потрібні поля file та removed' });
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get('document_removed_placeholders');
  let store = row ? JSON.parse(row.value) : {};
  if (Array.isArray(store)) store = { _base: store }; // migrate the old flat shape into _base, preserved as a shared fallback for every OTHER file until it gets its own specific entry too
  store[file] = removed;
  const json = JSON.stringify(store);
  const existing = db.prepare("SELECT key FROM settings WHERE key = ?").get('document_removed_placeholders');
  if (existing) db.prepare("UPDATE settings SET value = ?, updated_at = datetime('now') WHERE key = ?").run(json, 'document_removed_placeholders');
  else db.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").run('document_removed_placeholders', json);
  res.json({ ok: true });
});
// One-time migration: every existing template is still silently sharing the
// old, pre-per-template _base mapping as its fallback (never had its own
// byFile[file] entry saved yet) — this is what causes different templates
// that happen to reuse the same #placeholder text to affect each other.
// Gives each currently-in-use template file its own independent starting
// copy of the current (shared) values, so the admin only needs to ADJUST
// whichever specific fields should genuinely differ per template, rather
// than re-entering everything from scratch for every single one.
router.post('/mapping/migrate-to-per-template', auth, adminOnly, (req, res) => {
  const store = getMappingStore();
  const filesTouched = [];
  for (const repKey of Object.keys(DOCUMENT_TYPES)) {
    for (const t of DOCUMENT_TYPES[repKey]) {
      const file = templateFileName(t.key, repKey);
      if (!store.byFile[file]) {
        store.byFile[file] = { ...store._base };
        if (!filesTouched.includes(file)) filesTouched.push(file);
      }
    }
  }
  const json = JSON.stringify(store);
  const existing = db.prepare('SELECT key FROM settings WHERE key = ?').get(MAPPING_SETTINGS_KEY);
  if (existing) db.prepare("UPDATE settings SET value = ?, updated_at = datetime('now') WHERE key = ?").run(json, MAPPING_SETTINGS_KEY);
  else db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run(MAPPING_SETTINGS_KEY, json);
  res.json({ ok: true, filesTouched });
});

// ── Admin: template upload ───────────────────────────────────────
// ?repKey=xxx uploads a representative-specific template instead of the
// shared default — used when a ФОП needs their own contract/act wording.
router.post('/template/:type', auth, adminOnly, upload.single('file'), (req, res) => {
  const { type } = req.params;
  const repKey = (req.query.repKey || '').trim();
  if (!ALL_DOC_TYPE_KEYS.includes(type)) return res.status(400).json({ error: 'Невідомий тип шаблону' });
  if (!req.file) return res.status(400).json({ error: 'Файл не завантажено' });
  const fileName = repKey ? `${type}_${repKey}.docx` : `${type}.docx`;
  if (!fs.existsSync(TEMPLATES_DIR)) fs.mkdirSync(TEMPLATES_DIR, { recursive: true });
  fs.writeFileSync(path.join(TEMPLATES_DIR, fileName), req.file.buffer);
  // The uploaded file gets renamed to a fixed name on disk so the original
  // filename would otherwise be lost entirely — store it (plus who/when)
  // so the admin can tell which version is live.
  const infoKey = 'template_info_' + type + '_' + (repKey || 'default');
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
  if (!ALL_DOC_TYPE_KEYS.includes(type) || !repKey) return res.status(400).json({ error: 'Невідомий тип шаблону' });
  const filePath = path.join(TEMPLATES_DIR, `${type}_${repKey}.docx`);
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  const infoKey = 'template_info_' + type + '_' + repKey;
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
  const bookingId = req.query.bookingId;
  const rows = bookingId
    ? db.prepare(`SELECT id, booking_id, doc_type, file_name, client_name, vehicle_name, vehicle_plate, generated_by, contract_number, period_label, created_at
                  FROM generated_documents WHERE booking_id = ? ORDER BY created_at DESC`).all(Number(bookingId))
    : db.prepare(`SELECT id, booking_id, doc_type, file_name, client_name, vehicle_name, vehicle_plate, generated_by, contract_number, period_label, created_at
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
  if (!ALL_DOC_TYPE_KEYS.includes(type)) {
    return res.status(400).json({ error: 'Невідомий тип документа' });
  }

  const ctx = getBookingContext(bookingId);
  if (!ctx) return res.status(404).json({ error: 'Замовлення не знайдено' });

  // Extension act: same booking/contract, but the rental_start/rental_end/
  // rental_days/rate/currency fields should all reflect the extension
  // period specifically, not the original booking's — the resulting
  // document is archived under the same stable contract number either way
  // (that's derived from the bookingId, independent of which period this
  // specific generation used).
  // ?useExtension=1 uses the currently active (not yet committed) extension;
  // ?extHistoryIndex=N uses a specific already-saved past extension instead.
  let periodLabel = 'Основний'; // default: the document covers the booking's own original period
  if (req.query.useExtension === '1' && ctx.booking.extension?.fromDate && ctx.booking.extension?.toDate) {
    const ext = ctx.booking.extension;
    periodLabel = `Продовження (${fmtDateUk(ext.fromDate)}–${fmtDateUk(ext.toDate)})`;
    ctx.booking.start = ext.fromDate;
    ctx.booking.end = ext.toDate;
    ctx.booking.daysOverride = ext.days > 0 ? ext.days : 0;
    if (ext.rate > 0) ctx.booking.rate = ext.rate;
    if (ext.currency) ctx.booking.currency = ext.currency;
    if (ext.exchangeRate > 0) ctx.booking.exchangeRate = ext.exchangeRate;
  } else if (req.query.extHistoryIndex !== undefined) {
    const idx = parseInt(req.query.extHistoryIndex);
    const entry = ctx.booking.extensionHistory?.[idx];
    if (entry?.fromDate && entry?.toDate) {
      periodLabel = `Продовження (${fmtDateUk(entry.fromDate)}–${fmtDateUk(entry.toDate)})`;
      ctx.booking.start = entry.fromDate;
      ctx.booking.end = entry.toDate;
      ctx.booking.daysOverride = entry.days > 0 ? entry.days : 0;
      if (entry.rate > 0) ctx.booking.rate = entry.rate;
      if (entry.currency) ctx.booking.currency = entry.currency;
      if (entry.exchangeRate > 0) ctx.booking.exchangeRate = entry.exchangeRate;
    }
  }

  // Main-period payment-row acts (Платежі основного періоду оренди) need
  // Оплачено/Борг to reflect the state as of THIS SPECIFIC payment, not the
  // booking's current overall amountPaid — which by the time of printing
  // may already include later payments too, since payments are typically
  // all entered before any of their acts get (re)printed.
  if (req.query.paymentIndex !== undefined) {
    const pIdx = parseInt(req.query.paymentIndex);
    const payments = ctx.booking.payments || [];
    if (!isNaN(pIdx) && pIdx >= 0 && pIdx < payments.length) {
      const cumulativePaid = payments.slice(0, pIdx + 1).reduce((s, p) => s + (Number(p.amount) || 0), 0);
      ctx.booking.amountPaid = Math.round(cumulativePaid * 100) / 100;
    }
  }

  const repKey = ctx.repSlot;
  const templateFile = templateFileName(type, repKey);
  const templatePath = path.join(TEMPLATES_DIR, templateFile);
  if (!fs.existsSync(templatePath)) return res.status(404).json({ error: 'Шаблон не знайдено' });

  const contractNumber = getOrCreateContractNumber(ctx, bookingId);

  const mapping = getMappingForFile(templateFile);
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
    const label = docTypeLabel(repKey, type);
    // The contract itself keeps just the stable number in its filename;
    // every other document type (multiple acts, invoices, etc. can all be
    // generated more than once under the same contract number) gets a
    // generation timestamp appended too, so repeat downloads don't collide.
    const fileName = type === 'contract'
      ? `${contractNumber}_${label}.docx`
      : `${contractNumber}_${genStamp}_${label}.docx`;

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
      db.prepare(`INSERT INTO generated_documents (booking_id, doc_type, file_name, file_path, client_name, vehicle_name, vehicle_plate, generated_by, contract_number, period_label)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(Number(bookingId), type, fileName, diskName, clientName, vehicleName, vehiclePlate, req.user?.name || req.user?.username || '', contractNumber, periodLabel);
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
