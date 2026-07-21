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

// Only these image types are safe to pass through sharp/libvips for
// thumbnailing — HEIC/HEIF support varies by build, so skip those rather
// than risk a crash; the original still opens fine on click regardless.
const THUMBNAIL_MIME = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);

async function makeThumbnail(originalPath, dir) {
  const thumbName = crypto.randomBytes(16).toString('hex') + '_thumb.jpg';
  const thumbPath = path.join(dir, thumbName);
  await sharp(originalPath)
    .resize(400, 400, { fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 70 })
    .toFile(thumbPath);
  return thumbName;
}

// Renders page 1 of a PDF to a JPEG via `pdftoppm` (part of poppler-utils —
// must be installed on the server: `apt install poppler-utils`), then runs
// it through the same sharp resize/compress step as regular photos.
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
  try {
    const thumbName = crypto.randomBytes(16).toString('hex') + '_thumb.jpg';
    const thumbPath = path.join(dir, thumbName);
    await sharp(rawJpegPath)
      .resize(400, 400, { fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 70 })
      .toFile(thumbPath);
    return thumbName;
  } finally {
    fs.unlink(rawJpegPath, () => {}); // clean up the full-size intermediate render
  }
}

// POST /api/documents/:vid/:key — upload one file for a vehicle/doc-type
router.post('/:vid/:key', auth, (req, res) => {
  upload.single('file')(req, res, async (err) => {
    if (err) return res.status(400).json({ error: err.message || 'Не вдалося завантажити файл' });
    if (!req.file) return res.status(400).json({ error: 'Файл не отримано' });
    const vid = Number(req.params.vid);
    const key = req.params.key;
    if (!Number.isFinite(vid)) return res.status(400).json({ error: 'Невірний ID авто' });

    const relPath = path.relative(UPLOAD_DIR, req.file.path);
    const fixedOriginalName = fixEncoding(req.file.originalname);

    let thumbRelPath = null;
    if (THUMBNAIL_MIME.has(req.file.mimetype)) {
      try {
        const thumbName = await makeThumbnail(req.file.path, path.dirname(req.file.path));
        thumbRelPath = path.relative(UPLOAD_DIR, path.join(path.dirname(req.file.path), thumbName));
      } catch (e) {
        // Thumbnail generation failing shouldn't block the upload itself —
        // the UI just falls back to the full image for that one file.
        thumbRelPath = null;
      }
    } else if (req.file.mimetype === 'application/pdf') {
      try {
        const thumbName = await makePdfThumbnail(req.file.path, path.dirname(req.file.path));
        thumbRelPath = path.relative(UPLOAD_DIR, path.join(path.dirname(req.file.path), thumbName));
      } catch (e) {
        // pdftoppm missing or the PDF is unreadable — fall back to the
        // generic 📄 icon in the UI, upload still succeeds either way.
        thumbRelPath = null;
      }
    }

    const info = db.prepare(
      `INSERT INTO documents (vehicle_id, doc_type, filename, thumb_filename, original_name, mime_type, size, uploaded_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`
    ).run(vid, key, relPath, thumbRelPath, fixedOriginalName, req.file.mimetype, req.file.size, req.user?.id || null);

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

// GET /api/documents/:vid — list all documents for a vehicle
router.get('/:vid', auth, (req, res) => {
  const vid = Number(req.params.vid);
  if (!Number.isFinite(vid)) return res.status(400).json({ error: 'Невірний ID авто' });
  const rows = db.prepare('SELECT * FROM documents WHERE vehicle_id = ? ORDER BY created_at').all(vid);
  res.json(rows.map(r => ({
    ...r,
    url: relPathToUrl(r.filename),
    thumbUrl: r.thumb_filename ? relPathToUrl(r.thumb_filename) : null,
  })));
});

// DELETE /api/documents/:id — remove a document (DB row + underlying file)
router.delete('/:id', auth, (req, res) => {
  const id = Number(req.params.id);
  const row = db.prepare('SELECT * FROM documents WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ error: 'Не знайдено' });
  db.prepare('DELETE FROM documents WHERE id = ?').run(id);
  fs.unlink(path.join(UPLOAD_DIR, row.filename), () => {}); // best-effort cleanup
  if (row.thumb_filename) fs.unlink(path.join(UPLOAD_DIR, row.thumb_filename), () => {});
  res.json({ ok: true });
});

module.exports = router;
