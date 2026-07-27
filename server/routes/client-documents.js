const router = require('express').Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const sharp = require('sharp');
const db = require('../db');
const { auth } = require('./auth');

const UPLOAD_DIR = path.join(__dirname, '..', 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const ALLOWED_MIME = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif', 'application/pdf']);
const ALLOWED_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.heic', '.heif', '.pdf']);
const THUMBNAIL_MIME = new Set(['image/jpeg', 'image/png', 'image/webp']);

function sanitizeFolderName(str) {
  return String(str || '')
    .replace(/[\/\\:*?"<>|]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
}

function getClientFolderName(cid) {
  try {
    const row = db.prepare('SELECT data FROM clients WHERE id = ?').get(cid);
    if (row) {
      const c = JSON.parse(row.data || '{}');
      const raw = sanitizeFolderName(c.name || '');
      if (raw) return raw;
    }
  } catch { /* fall through */ }
  return `клієнт_${cid}`;
}

function fixEncoding(name) {
  if (!name) return name;
  try { return Buffer.from(name, 'latin1').toString('utf8'); }
  catch { return name; }
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const cid = Number(req.params.cid);
    const dir = path.join(UPLOAD_DIR, 'Клієнти', getClientFolderName(cid));
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(fixEncoding(file.originalname) || '') || '';
    cb(null, crypto.randomBytes(16).toString('hex') + ext);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(fixEncoding(file.originalname) || '').toLowerCase();
    if (ALLOWED_MIME.has(file.mimetype) || ALLOWED_EXT.has(ext)) cb(null, true);
    else cb(new Error('Непідтримуваний тип файлу'));
  },
});

function relPathToUrl(relPath) {
  return '/uploads/' + relPath.split(path.sep).map(encodeURIComponent).join('/');
}

async function makeThumbnail(originalPath, dir) {
  const thumbName = crypto.randomBytes(16).toString('hex') + '_thumb.jpg';
  const thumbPath = path.join(dir, thumbName);
  await sharp(originalPath)
    .resize(400, 400, { fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 70 })
    .toFile(thumbPath);
  return thumbName;
}

// POST /api/client-documents/:cid/:key — upload one file (key = passport | license | other)
router.post('/:cid/:key', auth, (req, res) => {
  upload.single('file')(req, res, async (err) => {
    if (err) return res.status(400).json({ error: err.message || 'Не вдалося завантажити файл' });
    if (!req.file) return res.status(400).json({ error: 'Файл не отримано' });
    const cid = Number(req.params.cid);
    const key = req.params.key;
    if (!Number.isFinite(cid)) return res.status(400).json({ error: 'Невірний ID клієнта' });

    const relPath = path.relative(UPLOAD_DIR, req.file.path);
    const fixedOriginalName = fixEncoding(req.file.originalname);

    let thumbRelPath = null;
    if (THUMBNAIL_MIME.has(req.file.mimetype)) {
      try {
        const thumbName = await makeThumbnail(req.file.path, path.dirname(req.file.path));
        thumbRelPath = path.relative(UPLOAD_DIR, path.join(path.dirname(req.file.path), thumbName));
      } catch (e) { thumbRelPath = null; }
    }

    const info = db.prepare(
      `INSERT INTO client_documents (client_id, doc_type, filename, thumb_filename, original_name, mime_type, size, uploaded_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`
    ).run(cid, key, relPath, thumbRelPath, fixedOriginalName, req.file.mimetype, req.file.size, req.user?.id || null);

    res.json({
      id: info.lastInsertRowid,
      doc_type: key,
      name: fixedOriginalName,
      type: req.file.mimetype,
      size: req.file.size,
      url: relPathToUrl(relPath),
      thumbUrl: thumbRelPath ? relPathToUrl(thumbRelPath) : null,
    });
  });
});

// GET /api/client-documents/:cid — list all documents for a client
router.get('/:cid', auth, (req, res) => {
  const cid = Number(req.params.cid);
  if (!Number.isFinite(cid)) return res.status(400).json({ error: 'Невірний ID клієнта' });
  const rows = db.prepare('SELECT * FROM client_documents WHERE client_id = ? ORDER BY created_at').all(cid);
  res.json(rows.map(r => ({
    ...r,
    url: relPathToUrl(r.filename),
    thumbUrl: r.thumb_filename ? relPathToUrl(r.thumb_filename) : null,
  })));
});

// DELETE /api/client-documents/:id
router.delete('/:id', auth, (req, res) => {
  const id = Number(req.params.id);
  const row = db.prepare('SELECT * FROM client_documents WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ error: 'Не знайдено' });
  db.prepare('DELETE FROM client_documents WHERE id = ?').run(id);
  fs.unlink(path.join(UPLOAD_DIR, row.filename), () => {});
  if (row.thumb_filename) fs.unlink(path.join(UPLOAD_DIR, row.thumb_filename), () => {});
  res.json({ ok: true });
});

module.exports = router;
