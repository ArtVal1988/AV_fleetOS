const router = require('express').Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const db = require('../db');
const { auth } = require('./auth');

const UPLOAD_DIR = path.join(__dirname, '..', 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// Only allow file types that are actually useful here (photos + common
// document formats) — keeps the upload directory from becoming an open
// dumping ground for arbitrary files.
const ALLOWED_MIME = new Set([
  'image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/heic', 'image/heif',
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
]);

const ALLOWED_EXT = new Set(['.png','.jpg','.jpeg','.webp','.gif','.heic','.heif','.pdf','.doc','.docx']);

function sanitizeFolderName(str) {
  return String(str || '')
    .replace(/[\/\\:*?"<>|]/g, '')   // strip filesystem-unsafe characters
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
}

// Human-browsable folder per vehicle: "Документи/<номер> <назва авто>/".
// Vehicle plate/name live in vehicles.service_data (JSON), not in their own
// columns — look them up there. Falls back to an ID-based folder if the
// vehicle was never saved through the app (no service_data row yet).
function getVehicleFolderName(vid) {
  try {
    const row = db.prepare('SELECT service_data FROM vehicles WHERE id = ?').get(vid);
    if (row) {
      const v = JSON.parse(row.service_data || '{}');
      const raw = sanitizeFolderName(`${v.plate || ''} ${v.name || ''}`);
      if (raw) return raw;
    }
  } catch { /* fall through to ID-based folder */ }
  return `авто_${vid}`;
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const vid = Number(req.params.vid);
    const dir = path.join(UPLOAD_DIR, 'Документи', getVehicleFolderName(vid));
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(fixEncoding(file.originalname) || '') || '';
    cb(null, crypto.randomBytes(16).toString('hex') + ext);
  },
});

// Multipart filenames arrive as UTF-8 bytes but Node/multer decode them as
// latin1 by default (per the multipart spec's historical ASCII assumption) —
// without this, Cyrillic/non-ASCII names show up as mojibake ("hieroglyphs").
function fixEncoding(name) {
  if (!name) return name;
  try { return Buffer.from(name, 'latin1').toString('utf8'); }
  catch { return name; }
}

const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(fixEncoding(file.originalname) || '').toLowerCase();
    if (ALLOWED_MIME.has(file.mimetype) || ALLOWED_EXT.has(ext)) cb(null, true);
    else cb(new Error('Непідтримуваний тип файлу'));
  },
});

// Build a proper URL from a filesystem-relative path (encode each segment,
// keep '/' separators — files can sit in Cyrillic/space-containing folders).
function relPathToUrl(relPath) {
  return '/uploads/' + relPath.split(path.sep).map(encodeURIComponent).join('/');
}

// POST /api/documents/:vid/:key — upload one file for a vehicle/doc-type
router.post('/:vid/:key', auth, (req, res) => {
  upload.single('file')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message || 'Не вдалося завантажити файл' });
    if (!req.file) return res.status(400).json({ error: 'Файл не отримано' });
    const vid = Number(req.params.vid);
    const key = req.params.key;
    if (!Number.isFinite(vid)) return res.status(400).json({ error: 'Невірний ID авто' });

    const relPath = path.relative(UPLOAD_DIR, req.file.path);
    const fixedOriginalName = fixEncoding(req.file.originalname);
    const info = db.prepare(
      `INSERT INTO documents (vehicle_id, doc_type, filename, original_name, mime_type, size, uploaded_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))`
    ).run(vid, key, relPath, fixedOriginalName, req.file.mimetype, req.file.size, req.user?.id || null);

    res.json({
      id: info.lastInsertRowid,
      doc_type: key,
      name: fixedOriginalName,
      type: req.file.mimetype,
      size: req.file.size,
      url: relPathToUrl(relPath),
    });
  });
});

// GET /api/documents/:vid — list all documents for a vehicle
router.get('/:vid', auth, (req, res) => {
  const vid = Number(req.params.vid);
  if (!Number.isFinite(vid)) return res.status(400).json({ error: 'Невірний ID авто' });
  const rows = db.prepare('SELECT * FROM documents WHERE vehicle_id = ? ORDER BY created_at').all(vid);
  res.json(rows.map(r => ({ ...r, url: relPathToUrl(r.filename) })));
});

// DELETE /api/documents/:id — remove a document (DB row + underlying file)
router.delete('/:id', auth, (req, res) => {
  const id = Number(req.params.id);
  const row = db.prepare('SELECT * FROM documents WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ error: 'Не знайдено' });
  db.prepare('DELETE FROM documents WHERE id = ?').run(id);
  fs.unlink(path.join(UPLOAD_DIR, row.filename), () => {}); // best-effort cleanup
  res.json({ ok: true });
});

module.exports = router;
