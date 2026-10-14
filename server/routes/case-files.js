// Files attached to insurance cases (страхові випадки): photos, PDFs, Office
// documents and archives. Stored on disk (not as base64 inside the vehicle
// JSON), photos/PDFs get a thumbnail like client documents do.
// The case itself (inside the vehicle's data) keeps only a small reference
// {fileId, title, name, type, size, url, thumbUrl} for each file.
const router = require('express').Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const sharp = require('sharp');
const { execFile } = require('child_process');
const db = require('../db');
const { auth } = require('./auth');

const UPLOAD_DIR = path.join(__dirname, '..', 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const ALLOWED_EXT = new Set([
  '.png', '.jpg', '.jpeg', '.webp', '.gif', '.heic', '.heif',
  '.pdf', '.doc', '.docx', '.xls', '.xlsx',
  '.zip', '.rar', '.7z', '.tar', '.gz', '.tgz',
]);
const THUMBNAIL_MIME = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
const COMPRESSIBLE_MIME = new Set(['image/jpeg', 'image/png', 'image/webp']);
const MAX_DIMENSION = 2400;
const MAX_FILE_SIZE = 25 * 1024 * 1024;

function sanitizeFolderName(str) {
  return String(str || '').replace(/[\/\\:*?"<>|]/g, '').replace(/\s+/g, ' ').trim().slice(0, 80);
}

function getVehicleFolderName(vid) {
  try {
    const row = db.prepare('SELECT service_data FROM vehicles WHERE id = ?').get(vid);
    if (row) {
      const v = JSON.parse(row.service_data || '{}');
      const raw = sanitizeFolderName(`${v.plate || ''} ${v.name || ''}`);
      if (raw) return raw;
    }
  } catch { /* fall through */ }
  return `авто_${vid}`;
}

function fixEncoding(name) {
  if (!name) return name;
  try { return Buffer.from(name, 'latin1').toString('utf8'); }
  catch { return name; }
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const vid = Number(req.params.vid);
    const dir = path.join(UPLOAD_DIR, 'Страхові випадки', getVehicleFolderName(vid));
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
  limits: { fileSize: MAX_FILE_SIZE },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(fixEncoding(file.originalname) || '').toLowerCase();
    if (ALLOWED_EXT.has(ext)) cb(null, true);
    else cb(new Error('Непідтримуваний тип файлу (дозволено: фото, PDF, Word/Excel, архіви ZIP/RAR/7z)'));
  },
});

function relPathToUrl(relPath) {
  return '/uploads/' + relPath.split(path.sep).map(encodeURIComponent).join('/');
}

async function makeThumbnail(originalPath, dir) {
  const thumbName = crypto.randomBytes(16).toString('hex') + '_thumb.jpg';
  await sharp(originalPath)
    .resize(400, 400, { fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 70 })
    .toFile(path.join(dir, thumbName));
  return thumbName;
}

// Page 1 of a PDF via `pdftoppm` (poppler-utils). If it isn't installed the
// PDF simply gets no thumbnail (a 📄 icon is shown instead).
function pdftoppmToFile(pdfPath, outBaseNoExt) {
  return new Promise((resolve, reject) => {
    execFile('pdftoppm', ['-jpeg', '-f', '1', '-l', '1', '-scale-to', '800', '-singlefile', pdfPath, outBaseNoExt], (err) => {
      if (err) return reject(err);
      resolve(outBaseNoExt + '.jpg');
    });
  });
}
async function makePdfThumbnail(pdfPath, dir) {
  const rawBase = path.join(dir, crypto.randomBytes(16).toString('hex') + '_pdfraw');
  const rawJpegPath = await pdftoppmToFile(pdfPath, rawBase);
  try { return await makeThumbnail(rawJpegPath, dir); }
  finally { fs.unlink(rawJpegPath, () => {}); }
}

async function compressImageInPlace(filePath, mimeType) {
  if (!COMPRESSIBLE_MIME.has(mimeType)) return null;
  const pipeline = sharp(filePath).rotate()
    .resize(MAX_DIMENSION, MAX_DIMENSION, { fit: 'inside', withoutEnlargement: true });
  const encoded = mimeType === 'image/jpeg' ? pipeline.jpeg({ quality: 85, mozjpeg: true })
    : mimeType === 'image/png' ? pipeline.png({ compressionLevel: 9, palette: true })
    : pipeline.webp({ quality: 85 });
  const buffer = await encoded.toBuffer();
  await sharp(buffer).toFile(filePath);
  return buffer.length;
}

// POST /api/case-files/:vid — upload one file for an insurance case of a vehicle
router.post('/:vid', auth, (req, res) => {
  upload.single('file')(req, res, async (err) => {
    if (err) return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'Файл завеликий (максимум 25 МБ)' : (err.message || 'Не вдалося завантажити файл') });
    if (!req.file) return res.status(400).json({ error: 'Файл не отримано' });
    const vid = Number(req.params.vid);
    if (!Number.isFinite(vid)) return res.status(400).json({ error: 'Невірний ID авто' });

    const dir = path.dirname(req.file.path);
    const relPath = path.relative(UPLOAD_DIR, req.file.path);
    const originalName = fixEncoding(req.file.originalname);
    const ext = path.extname(originalName).toLowerCase();
    // Browsers report archives/HEIC inconsistently — derive a sane type from the extension when needed.
    let mime = req.file.mimetype;
    if (ext === '.pdf') mime = 'application/pdf';

    let finalSize = req.file.size;
    try {
      const compressed = await compressImageInPlace(req.file.path, mime);
      if (compressed) finalSize = compressed;
    } catch { /* keep the original */ }

    let thumbRelPath = null;
    try {
      let thumbName = null;
      if (THUMBNAIL_MIME.has(mime)) thumbName = await makeThumbnail(req.file.path, dir);
      else if (mime === 'application/pdf') thumbName = await makePdfThumbnail(req.file.path, dir);
      if (thumbName) thumbRelPath = path.relative(UPLOAD_DIR, path.join(dir, thumbName));
    } catch { thumbRelPath = null; }

    const info = db.prepare(
      `INSERT INTO case_files (vehicle_id, filename, thumb_filename, original_name, mime_type, size, uploaded_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))`
    ).run(vid, relPath, thumbRelPath, originalName, mime, finalSize, req.user?.id || null);

    res.json({
      fileId: Number(info.lastInsertRowid),
      name: originalName,
      type: mime,
      size: finalSize,
      url: relPathToUrl(relPath),
      thumbUrl: thumbRelPath ? relPathToUrl(thumbRelPath) : null,
    });
  });
});

// DELETE /api/case-files/:id — remove the DB row and the files on disk
router.delete('/:id', auth, (req, res) => {
  const id = Number(req.params.id);
  const row = db.prepare('SELECT * FROM case_files WHERE id = ?').get(id);
  if (!row) return res.json({ ok: true }); // already gone
  db.prepare('DELETE FROM case_files WHERE id = ?').run(id);
  fs.unlink(path.join(UPLOAD_DIR, row.filename), () => {});
  if (row.thumb_filename) fs.unlink(path.join(UPLOAD_DIR, row.thumb_filename), () => {});
  res.json({ ok: true });
});

module.exports = router;
