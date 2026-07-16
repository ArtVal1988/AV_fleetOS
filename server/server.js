require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// ── Middleware ───────────────────────────────────────────────────
app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ── Routes ───────────────────────────────────────────────────────
const { router: authRouter } = require('./routes/auth');
app.use('/api/auth', authRouter);
app.use('/api/bookings', require('./routes/bookings'));
app.use('/api/vehicles', require('./routes/vehicles'));
app.use('/api/stickers', require('./routes/stickers'));
app.use('/api/settings', require('./routes/settings'));

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
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`\n🚗 AV_fleetOS Server запущено на порту ${PORT}`);
  console.log(`   http://localhost:${PORT}\n`);
});
