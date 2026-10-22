const router = require('express').Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const db = require('../db');
const telegram = require('../telegram');

const SECRET = process.env.JWT_SECRET || 'av_fleetos_2026_08_17_force_relogin';
const EXPIRES = process.env.JWT_EXPIRES_IN || '7d';

// ── Middleware: verify token ─────────────────────────────────────
function auth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Не авторизовано' });
  try {
    req.user = jwt.verify(token, SECRET);
    // The token itself stays valid for up to EXPIRES regardless of what
    // happens to the account afterward — re-check the DB on every request
    // so a deactivated user is immediately kicked out, not just blocked
    // from a fresh login while their existing session keeps working.
    const row = db.prepare('SELECT active FROM users WHERE id = ?').get(req.user.id);
    if (!row || !row.active) return res.status(401).json({ error: 'Обліковий запис деактивовано' });
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

function issueToken(user) {
  return jwt.sign(
    { id: user.id, username: user.username, name: user.name, role: user.role },
    SECRET,
    { expiresIn: EXPIRES }
  );
}
// Owner mode (TG_OWNER_USERNAME=<login> in .env): every login code goes to the
// OWNER's Telegram only, and the owner passes it on to the person logging in.
// Without it, each user receives the code in their own linked Telegram.
function ownerLogin() { return (process.env.TG_OWNER_USERNAME || '').trim(); }
function ownerRow() {
  const login = ownerLogin();
  return login ? db.prepare('SELECT id, username, name, tg_chat_id FROM users WHERE username = ? AND active = 1').get(login) : null;
}
// Does this user have to link a Telegram chat to their own account?
function needsLink(user) {
  if (!telegram.enabled() || user.tg_chat_id) return false;
  return ownerLogin() ? user.username === ownerLogin() : true;
}
function publicUser(user) {
  return {
    id: user.id, username: user.username, name: user.name, role: user.role,
    tgEnabled: telegram.enabled(),
    tgLinked: !!user.tg_chat_id,
    tgNeedsLink: needsLink(user),
    tgOwnerMode: !!ownerLogin(),
  };
}

// ── Two-step login: after a correct password the server sends a 6-digit code
// to the user's linked Telegram chat; the session token is issued only once
// that code is entered. Challenges live in memory (5 min, 5 attempts).
const challenges = new Map(); // id -> { userId, codeHash, expires, attempts }
const CHALLENGE_TTL = 5 * 60 * 1000;
const MAX_ATTEMPTS = 5;
const sha = (v) => crypto.createHash('sha256').update(String(v)).digest();
setInterval(() => {
  const now = Date.now();
  for (const [id, c] of challenges) if (c.expires < now) challenges.delete(id);
}, 60 * 1000).unref();

// POST /api/auth/login
router.post('/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password)
    return res.status(400).json({ error: 'Введіть логін та пароль' });

  const user = db.prepare('SELECT * FROM users WHERE username = ? AND active = 1').get(username);
  if (!user || !bcrypt.compareSync(password, user.password))
    return res.status(401).json({ error: 'Невірний логін або пароль' });

  // Who receives the code: the owner (owner mode) or the user themselves.
  let recipientChat = null, ownerMode = false;
  if (telegram.enabled()) {
    if (ownerLogin()) {
      ownerMode = true;
      const owner = ownerRow();
      recipientChat = owner && owner.tg_chat_id;
      // The owner has to be able to log in without a code to link his Telegram;
      // everybody else waits until that is done (never silently skipped).
      if (!recipientChat && user.username !== ownerLogin())
        return res.status(503).json({ error: 'Вхід тимчасово недоступний: адміністратор ще не налаштував підтвердження через Telegram.' });
    } else {
      recipientChat = user.tg_chat_id;
    }
  }

  if (recipientChat) {
    const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
    const challengeId = crypto.randomBytes(24).toString('hex');
    const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').toString().split(',')[0].trim();
    const text = ownerMode
      ? `🔐 AV_fleetOS: запит на вхід\n\nКористувач: ${user.name} (@${user.username})${ip ? '\nIP: ' + ip : ''}\n\nКод: ${code}\n\nДійсний 5 хвилин. Передайте код лише цій людині, якщо ви очікуєте її вхід.`
      : `🔐 AV_fleetOS: код входу ${code}\n\nДійсний 5 хвилин. Вхід для «${user.name}»${ip ? ' з IP ' + ip : ''}.\nЯкщо це не ви — нікому не повідомляйте код і змініть пароль.`;
    try {
      await telegram.sendMessage(recipientChat, text);
    } catch (e) {
      console.error('[auth] telegram send failed:', e.message);
      return res.status(502).json({ error: 'Не вдалося надіслати код у Telegram. Спробуйте ще раз або зверніться до адміністратора.' });
    }
    challenges.set(challengeId, { userId: user.id, codeHash: sha(code), expires: Date.now() + CHALLENGE_TTL, attempts: 0 });
    return res.json({ needs2fa: true, challengeId });
  }

  res.json({ token: issueToken(user), user: publicUser(user) });
});

// POST /api/auth/login/verify — second step: the code from Telegram
router.post('/login/verify', (req, res) => {
  const { challengeId, code } = req.body || {};
  const c = challenges.get(String(challengeId || ''));
  if (!c || c.expires < Date.now()) {
    if (c) challenges.delete(challengeId);
    return res.status(401).json({ error: 'Код прострочено. Увійдіть заново.', expired: true });
  }
  c.attempts += 1;
  const ok = crypto.timingSafeEqual(sha(String(code || '').trim()), c.codeHash);
  if (!ok) {
    if (c.attempts >= MAX_ATTEMPTS) {
      challenges.delete(challengeId);
      return res.status(401).json({ error: 'Забагато невірних спроб. Увійдіть заново.', expired: true });
    }
    return res.status(401).json({ error: `Невірний код (залишилось спроб: ${MAX_ATTEMPTS - c.attempts})` });
  }
  challenges.delete(challengeId);
  const user = db.prepare('SELECT * FROM users WHERE id = ? AND active = 1').get(c.userId);
  if (!user) return res.status(401).json({ error: 'Обліковий запис недоступний' });
  res.json({ token: issueToken(user), user: publicUser(user) });
});

// POST /api/auth/check-password — verifies the current user's own password
// (used by "change password"); never sends a Telegram code.
router.post('/check-password', auth, (req, res) => {
  const user = db.prepare('SELECT password FROM users WHERE id = ?').get(req.user.id);
  const ok = !!user && bcrypt.compareSync(String(req.body?.password || ''), user.password);
  if (!ok) return res.status(401).json({ error: 'Невірний пароль' });
  res.json({ ok: true });
});

// GET /api/auth/me
router.get('/me', auth, (req, res) => {
  const row = db.prepare('SELECT username, tg_chat_id FROM users WHERE id = ?').get(req.user.id);
  res.json({ ...req.user, tgEnabled: telegram.enabled(), tgLinked: !!(row && row.tg_chat_id), tgNeedsLink: !!row && needsLink(row), tgOwnerMode: !!ownerLogin() });
});

// ── Telegram linking (for the logged-in user) ────────────────────
// POST /api/auth/telegram/link-code
router.post('/telegram/link-code', auth, async (req, res) => {
  if (!telegram.enabled()) return res.status(400).json({ error: 'Підтвердження через Telegram не увімкнено' });
  const me = db.prepare('SELECT username, tg_chat_id FROM users WHERE id = ?').get(req.user.id);
  if (ownerLogin() && me.username !== ownerLogin())
    return res.status(403).json({ error: 'Прив\'язка Telegram потрібна лише власнику.' });
  const code = telegram.createLinkCode(req.user.id);
  const bot = await telegram.getBotUsername();
  res.json({ code, bot, url: bot ? `https://t.me/${bot}?start=${code}` : null, expiresInMin: 10 });
});
// GET /api/auth/telegram/status
router.get('/telegram/status', auth, (req, res) => {
  const row = db.prepare('SELECT tg_chat_id, tg_username FROM users WHERE id = ?').get(req.user.id);
  res.json({ enabled: telegram.enabled(), linked: !!(row && row.tg_chat_id), username: row?.tg_username || null });
});

// ── User management (admin only) ─────────────────────────────────

// GET /api/auth/users
router.get('/users', auth, adminOnly, (req, res) => {
  const users = db.prepare('SELECT id, username, name, role, active, created_at, tg_chat_id, tg_username FROM users').all()
    .map(({ tg_chat_id, ...u }) => ({
      ...u, tgLinked: !!tg_chat_id,
      tgRole: !telegram.enabled() ? 'off' : (ownerLogin() ? (u.username === ownerLogin() ? 'owner' : 'none') : 'self'),
    }));
  res.json(users);
});

// POST /api/auth/users
router.post('/users', auth, adminOnly, (req, res) => {
  const { username, password, name, role = 'manager' } = req.body;
  if (!username || !password || !name)
    return res.status(400).json({ error: 'Заповніть всі поля' });
  if (!['admin', 'manager', 'accountant'].includes(role))
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
  const { name, role, active, password, tgReset } = req.body;
  if (tgReset && isAdmin) {
    const owner = ownerRow();
    if (owner && owner.id === targetId && req.user.id !== owner.id)
      return res.status(403).json({ error: 'Прив\'язку власника може скинути лише він сам.' });
  }
  if (password) db.prepare('UPDATE users SET password = ? WHERE id = ?').run(bcrypt.hashSync(password, 10), targetId);
  if (name && isAdmin) db.prepare('UPDATE users SET name = ? WHERE id = ?').run(name, targetId);
  if (role && isAdmin) db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, targetId);
  if (tgReset && isAdmin) db.prepare('UPDATE users SET tg_chat_id = NULL, tg_username = NULL WHERE id = ?').run(targetId);
  if (active !== undefined && isAdmin) db.prepare('UPDATE users SET active = ? WHERE id = ?').run(active ? 1 : 0, targetId);

  res.json({ ok: true });
});

// DELETE /api/auth/users/:id
router.delete('/users/:id', auth, adminOnly, (req, res) => {
  if (parseInt(req.params.id) === req.user.id)
    return res.status(400).json({ error: 'Не можна видалити власний акаунт' });
  db.prepare('DELETE FROM users WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

module.exports = { router, auth, adminOnly };
