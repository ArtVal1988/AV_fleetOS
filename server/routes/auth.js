const router = require('express').Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('../db');

const SECRET = process.env.JWT_SECRET || 'change_me';
const EXPIRES = process.env.JWT_EXPIRES_IN || '7d';

// ── Middleware: verify token ─────────────────────────────────────
function auth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Не авторизовано' });
  try {
    req.user = jwt.verify(token, SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Токен недійсний або прострочений' });
  }
}

// ── Middleware: admin only ───────────────────────────────────────
function adminOnly(req, res, next) {
  if (req.user?.role !== 'admin') {
    return res.status(403).json({ error: 'Доступ лише для адміністратора' });
  }
  next();
}

// POST /api/auth/login
router.post('/login', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password)
    return res.status(400).json({ error: 'Введіть логін та пароль' });

  const user = db.prepare('SELECT * FROM users WHERE username = ? AND active = 1').get(username);
  if (!user || !bcrypt.compareSync(password, user.password))
    return res.status(401).json({ error: 'Невірний логін або пароль' });

  const token = jwt.sign(
    { id: user.id, username: user.username, name: user.name, role: user.role },
    SECRET,
    { expiresIn: EXPIRES }
  );

  res.json({ token, user: { id: user.id, username: user.username, name: user.name, role: user.role } });
});

// GET /api/auth/me
router.get('/me', auth, (req, res) => {
  res.json(req.user);
});

// ── User management (admin only) ─────────────────────────────────

// GET /api/auth/users
router.get('/users', auth, adminOnly, (req, res) => {
  const users = db.prepare('SELECT id, username, name, role, active, created_at FROM users').all();
  res.json(users);
});

// POST /api/auth/users
router.post('/users', auth, adminOnly, (req, res) => {
  const { username, password, name, role = 'manager' } = req.body;
  if (!username || !password || !name)
    return res.status(400).json({ error: 'Заповніть всі поля' });
  if (!['admin', 'manager'].includes(role))
    return res.status(400).json({ error: 'Невірна роль' });

  const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
  if (existing) return res.status(409).json({ error: 'Логін вже зайнятий' });

  const hash = bcrypt.hashSync(password, 10);
  const result = db.prepare(
    'INSERT INTO users (username, password, name, role) VALUES (?, ?, ?, ?)'
  ).run(username, hash, name, role);

  res.status(201).json({ id: result.lastInsertRowid, username, name, role });
});

// PUT /api/auth/users/:id — власний пароль або адмін
router.put('/users/:id', auth, (req, res) => {
  const targetId = parseInt(req.params.id);
  const isSelf = targetId === req.user.id;
  const isAdmin = req.user.role === 'admin';
  if (!isSelf && !isAdmin) return res.status(403).json({ error: 'Немає доступу' });
  const { name, role, active, password } = req.body;
  if (password) db.prepare('UPDATE users SET password = ? WHERE id = ?').run(bcrypt.hashSync(password, 10), targetId);
  if (name && isAdmin) db.prepare('UPDATE users SET name = ? WHERE id = ?').run(name, targetId);
  if (role && isAdmin) db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, targetId);
  if (active !== undefined && isAdmin) db.prepare('UPDATE users SET active = ? WHERE id = ?').run(active ? 1 : 0, targetId);

  res.json({ ok: true });
});

// DELETE /api/auth/users/:id
router.delete('/users/:id', auth, adminOnly, (req, res) => {
  if (parseInt(req.params.id) === req.user.id)
    return res.status(400).json({ error: 'Не можна видалити власний акаунт' });
  db.prepare('UPDATE users SET active = 0 WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

module.exports = { router, auth, adminOnly };
