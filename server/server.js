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

// ── Routes ───────────────────────────────────────────────────────
const { router: authRouter } = require('./routes/auth');
app.use('/api/auth', authRouter);
app.use('/api/bookings', require('./routes/bookings'));
app.use('/api/vehicles', require('./routes/vehicles'));
app.use('/api/stickers', require('./routes/stickers'));
app.use('/api/settings', require('./routes/settings'));
app.use('/api/price-check', require('./routes/price-check'));

// ── Backup endpoint ──────────────────────────────────────────────
const { auth, adminOnly } = require('./routes/auth');
const db = require('./db');

app.get('/api/backup', auth, adminOnly, (req, res) => {
  const data = {
    exportedAt: new Date().toISOString(),
    bookings: db.prepare('SELECT * FROM bookings').all(),
    vehicles: db.prepare('SELECT * FROM vehicles').all(),
    stickers: db.prepare('SELECT * FROM stickers').all(),
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
