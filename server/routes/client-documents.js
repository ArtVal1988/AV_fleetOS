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

// POST /api/client-documents/:id/rotate — body: { degrees: 90 | -90 | 180 }
// Physically rotates and overwrites the file (and its thumbnail, if any) —
// not just a view-only CSS rotation — so downloads/shares are correctly
// oriented too, matching what the user sees. Registered BEFORE the
// /:cid/:key upload route below — both are POST with a 2-segment shape,
// and Express matches whichever is registered first, so this MUST come
// first or every rotate request gets silently swallowed by the upload
// handler instead (cid='id', key='rotate').
router.post('/:id/rotate', auth, async (req, res) => {
  const id = Number(req.params.id);
  const degrees = Number(req.body?.degrees);
  if (![90, -90, 180].includes(degrees)) {
    console.error('[rotate] Invalid degrees for document', id, ':', req.body);
    return res.status(400).json({ error: 'Некоректний кут повороту' });
  }
  const row = db.prepare('SELECT * FROM client_documents WHERE id = ?').get(id);
  if (!row) {
    console.error('[rotate] Document not found:', id);
    return res.status(404).json({ error: 'Не знайдено' });
  }
  if (!THUMBNAIL_MIME.has(row.mime_type)) {
    console.error('[rotate] Unsupported mime type for document', id, ':', row.mime_type);
    return res.status(400).json({ error: 'Цей тип файлу не можна повернути' });
  }
  try {
    const fullPath = path.join(UPLOAD_DIR, row.filename);
    const rotated = await sharp(fullPath).rotate(degrees).toBuffer();
    await sharp(rotated).toFile(fullPath);
    if (row.thumb_filename) {
      const thumbPath = path.join(UPLOAD_DIR, row.thumb_filename);
      const rotatedThumb = await sharp(thumbPath).rotate(degrees).toBuffer();
      await sharp(rotatedThumb).toFile(thumbPath);
    }
    res.json({ ok: true });
  } catch (e) {
    console.error('[rotate] Failed for document', id, ':', e);
    res.status(500).json({ error: 'Не вдалося повернути файл' });
  }
});

// POST /api/client-documents/:cid/:key — upload one file (key = passport | license | other)
// Resizes (only if larger than the cap, never upscales) and re-encodes at a
// quality setting that's visually indistinguishable for document photos,
// preserving the original format so the file extension still matches its
// actual content. Returns the new file size in bytes, or null if this
// format isn't handled here (left untouched).
const COMPRESSIBLE_MIME = new Set(['image/jpeg', 'image/png', 'image/webp']);
const MAX_DIMENSION = 2400;
async function compressImageInPlace(filePath, mimeType) {
  if (!COMPRESSIBLE_MIME.has(mimeType)) return null;
  const pipeline = sharp(filePath).rotate() // auto-orient from EXIF before resizing, so the saved file doesn't rely on EXIF orientation anymore
    .resize(MAX_DIMENSION, MAX_DIMENSION, { fit: 'inside', withoutEnlargement: true });
  const encoded = mimeType === 'image/jpeg' ? pipeline.jpeg({ quality: 85, mozjpeg: true })
    : mimeType === 'image/png' ? pipeline.png({ compressionLevel: 9, palette: true })
    : pipeline.webp({ quality: 85 });
  const buffer = await encoded.toBuffer();
  await sharp(buffer).toFile(filePath);
  return buffer.length;
}

router.post('/:cid/:key', auth, (req, res) => {
  upload.single('file')(req, res, async (err) => {
    if (err) return res.status(400).json({ error: err.message || 'Не вдалося завантажити файл' });
    if (!req.file) return res.status(400).json({ error: 'Файл не отримано' });
    const cid = Number(req.params.cid);
    const key = req.params.key;
    if (!Number.isFinite(cid)) return res.status(400).json({ error: 'Невірний ID клієнта' });

    const relPath = path.relative(UPLOAD_DIR, req.file.path);
    const fixedOriginalName = fixEncoding(req.file.originalname);

    let finalSize = req.file.size;
    try {
      const compressedSize = await compressImageInPlace(req.file.path, req.file.mimetype);
      if (compressedSize) finalSize = compressedSize;
    } catch (e) { /* compression failed — keep the original file as uploaded */ }

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
    ).run(cid, key, relPath, thumbRelPath, fixedOriginalName, req.file.mimetype, finalSize, req.user?.id || null);

    res.json({
      id: info.lastInsertRowid,
      doc_type: key,
      name: fixedOriginalName,
      type: req.file.mimetype,
      size: finalSize,
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
