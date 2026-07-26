const router = require('express').Router();
const fs = require('fs');
const path = require('path');
const JSZip = require('jszip');
const db = require('../db');
const { auth } = require('./auth');

function fmtDateUk(iso) {
  if (!iso) return '';
  const [y, m, d] = iso.split('-');
  return `${d}.${m}.${y}`;
}

// Replace #placeholder tokens in the docx's document.xml with real values.
// Values are XML-escaped since they get inserted directly into the markup.
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

// GET /api/generate-document/:bookingId/:type  (type = contract | act)
router.get('/:bookingId/:type', auth, async (req, res) => {
  const { bookingId, type } = req.params;
  if (!['contract', 'act'].includes(type)) {
    return res.status(400).json({ error: 'Невідомий тип документа' });
  }

  const ctx = getBookingContext(bookingId);
  if (!ctx) return res.status(404).json({ error: 'Замовлення не знайдено' });
  const { booking: b, vehicle: v, client: c } = ctx;

  const spec = v.specs || {};
  const vehicleName = [spec.brand, spec.model].filter(Boolean).join(' ') || v.name || '';
  const clientName = c?.name || b.customer?.name || '';
  const clientPhone = c?.phone || b.customer?.phone || '';
  const todayIso = new Date().toISOString().split('T')[0];

  try {
    let fileBuffer, fileName;
    if (type === 'contract') {
      const values = {
        'номер': String(b.id),
        'дата': fmtDateUk(todayIso),
        'фирма1': vehicleName,
        'код1': v.plate || '',
        'фирма2': b.customer?.company || clientName,
        'код2': b.customer?.edrpou || c?.inn || '',
        'лицо2': clientName,
        'адрес2': clientPhone,
      };
      fileBuffer = await fillTemplate(path.join(__dirname, '..', 'templates', 'dogovir.docx'), values);
      fileName = `Договір_${b.id}_${vehicleName}.docx`;
    } else {
      const values = {
        'номер': String(b.id),
        'дата': fmtDateUk(todayIso),
        'фирма1': vehicleName,
        'код1': v.plate || '',
        'счет1': v.vin || '',
        'адрес1': v.sts?.number || '',
        'лицо2': clientName,
        'адрес2': clientPhone,
      };
      fileBuffer = await fillTemplate(path.join(__dirname, '..', 'templates', 'akt.docx'), values);
      fileName = `Акт_${b.id}_${vehicleName}.docx`;
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
