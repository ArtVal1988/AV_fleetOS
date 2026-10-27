require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
app.set('etag', false);

// ── Middleware ───────────────────────────────────────────────────
app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public'), {
  etag: false,
  lastModified: false,
  cacheControl: false,
  setHeaders: (res) => res.set('Cache-Control', 'no-store'),
}));

// API responses carry per-user, frequently-changing data behind auth tokens —
// never let the browser cache or conditionally-revalidate (ETag/304) them.
app.use('/api', (req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});

const fs = require('fs');
const crypto = require('crypto');
app.get('/api/app-version', (req, res) => {
  try {
    const html = fs.readFileSync(path.join(__dirname, 'public', 'index.html'));
    const hash = crypto.createHash('md5').update(html).digest('hex');
    res.set('Cache-Control', 'no-store').json({ version: hash });
  } catch (e) {
    res.status(500).json({ error: 'version check failed' });
  }
});

// ── Routes ───────────────────────────────────────────────────────
const { router: authRouter } = require('./routes/auth');
// Safety net for the activity log: a successful POST/PUT/PATCH/DELETE on an API
// route that does not log itself (e.g. one added in the future) still leaves a
// generic entry, so nothing a user changes can go completely unrecorded.
const SELF_LOGGING = ['/api/auth', '/api/bookings', '/api/vehicles', '/api/stickers', '/api/clients',
  '/api/generate-document', '/api/client-documents', '/api/case-files', '/api/activity-log',
  '/api/settings', '/api/documents', '/api/spare-parts', '/api/price-check'];
app.use('/api', (req, res, next) => {
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
    const full = req.baseUrl + req.path;
    if (!SELF_LOGGING.some(p => full === p || full.startsWith(p + '/'))) {
      res.on('finish', () => {
        if (res.statusCode < 400) {
          require('./activityLog').logReq(req, {
            action: req.method === 'DELETE' ? 'delete' : (req.method === 'POST' ? 'create' : 'update'),
            entityType: 'other', entityId: null, summary: `${req.method} ${full}`,
          });
        }
      });
    }
  }
  next();
});

app.use('/api/auth', authRouter);
app.use('/api/bookings', require('./routes/bookings'));
app.use('/api/vehicles', require('./routes/vehicles'));
app.use('/api/stickers', require('./routes/stickers'));
app.use('/api/clients', require('./routes/clients'));
app.use('/api/generate-document', require('./routes/generate-document'));
app.use('/api/client-documents', require('./routes/client-documents'));
app.use('/api/case-files', require('./routes/case-files'));
app.use('/api/activity-log', require('./routes/activity-log'));
app.use('/api/settings', require('./routes/settings'));
app.use('/api/price-check', require('./routes/price-check'));
app.use('/api/documents', require('./routes/documents'));
app.use('/api/spare-parts', require('./routes/spare-parts'));

// Uploaded document/photo files — served with normal caching (they're
// content-addressed by random filename, safe to cache) but access to the
// listing/upload/delete endpoints above still requires auth.
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// ── Backup endpoint ──────────────────────────────────────────────
const { auth, adminOnly } = require('./routes/auth');
const db = require('./db');
require('./telegram').startPolling();

app.get('/api/backup', auth, adminOnly, (req, res) => {
  const data = {
    exportedAt: new Date().toISOString(),
    bookings: db.prepare('SELECT * FROM bookings').all(),
    vehicles: db.prepare('SELECT * FROM vehicles').all(),
    stickers: db.prepare('SELECT * FROM stickers').all(),
    clients: db.prepare('SELECT * FROM clients').all(),
    settings: db.prepare('SELECT * FROM settings').all(),
    users: db.prepare('SELECT id, username, name, role, active FROM users').all(),
  };
  res.setHeader('Content-Disposition', `attachment; filename="AV_fleetOS-backup-${Date.now()}.json"`);
  res.json(data);
});

// ── Health check ─────────────────────────────────────────────────
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});

// ── SPA fallback ─────────────────────────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'), {
    etag: false,
    lastModified: false,
    cacheControl: false,
    headers: { 'Cache-Control': 'no-store' },
  });
});

app.listen(PORT, () => {
  console.log(`\n🚗 AV_fleetOS Server запущено на порту ${PORT}`);
  console.log(`   http://localhost:${PORT}\n`);
});
