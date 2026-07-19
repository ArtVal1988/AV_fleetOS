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

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname || '') || '';
    cb(null, crypto.randomBytes(16).toString('hex') + ext);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (ALLOWED_MIME.has(file.mimetype)) cb(null, true);
    else cb(new Error('Непідтримуваний тип файлу'));
  },
});

// POST /api/documents/:vid/:key — upload one file for a vehicle/doc-type
router.post('/:vid/:key', auth, (req, res) => {
  upload.single('file')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message || 'Не вдалося завантажити файл' });
    if (!req.file) return res.status(400).json({ error: 'Файл не отримано' });
    const vid = Number(req.params.vid);
    const key = req.params.key;
    if (!Number.isFinite(vid)) return res.status(400).json({ error: 'Невірний ID авто' });

    const info = db.prepare(
      `INSERT INTO documents (vehicle_id, doc_type, filename, original_name, mime_type, size, uploaded_by)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(vid, key, req.file.filename, req.file.originalname, req.file.mimetype, req.file.size, req.user?.id || null);

    res.json({
      id: info.lastInsertRowid,
      doc_type: key,
      name: req.file.originalname,
      type: req.file.mimetype,
      size: req.file.size,
      url: '/uploads/' + req.file.filename,
    });
  });
});

// GET /api/documents/:vid — list all documents for a vehicle
router.get('/:vid', auth, (req, res) => {
  const vid = Number(req.params.vid);
  if (!Number.isFinite(vid)) return res.status(400).json({ error: 'Невірний ID авто' });
  const rows = db.prepare('SELECT * FROM documents WHERE vehicle_id = ? ORDER BY created_at').all(vid);
  res.json(rows);
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
