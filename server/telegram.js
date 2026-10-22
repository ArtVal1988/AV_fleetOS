// Telegram bot used for two-step login confirmation (one-time codes) and for
// linking a user's Telegram chat to their account.
//
// Needs TELEGRAM_BOT_TOKEN in .env (create the bot with @BotFather). Without a
// token — or with TG_2FA_DISABLED=1 (emergency switch) — everything here is
// switched off and login works as before.
//
// Messages from Telegram are received by long polling (getUpdates), so no
// public webhook is needed. Run only ONE process per bot token (use a separate
// bot for the test site).
const crypto = require('crypto');
const db = require('./db');

const API_BASE = (process.env.TELEGRAM_API_BASE || 'https://api.telegram.org').replace(/\/$/, '');

function token() { return process.env.TELEGRAM_BOT_TOKEN || ''; }
function enabled() { return !!token() && process.env.TG_2FA_DISABLED !== '1'; }

async function api(method, payload, timeoutMs = 15000) {
  const r = await fetch(`${API_BASE}/bot${token()}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload || {}),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok || !data.ok) {
    const err = new Error(data.description || `Telegram API ${r.status}`);
    err.status = r.status;
    throw err;
  }
  return data.result;
}

function sendMessage(chatId, text) {
  return api('sendMessage', { chat_id: chatId, text });
}

let botUsername = null;
async function getBotUsername() {
  if (botUsername) return botUsername;
  try { botUsername = (await api('getMe')).username || null; } catch { /* retried next call */ }
  return botUsername;
}

// ── One-time linking codes: a logged-in user asks for a code, then sends it to
// the bot (via the t.me/<bot>?start=<code> deep link). In memory, 10 minutes.
const linkCodes = new Map(); // code -> { userId, expires }
const LINK_TTL = 10 * 60 * 1000;
function createLinkCode(userId) {
  for (const [c, v] of linkCodes) if (v.userId === userId || v.expires < Date.now()) linkCodes.delete(c);
  const code = crypto.randomBytes(5).toString('hex').toUpperCase(); // 10 hex chars
  linkCodes.set(code, { userId, expires: Date.now() + LINK_TTL });
  return code;
}

function linkChat(code, chat) {
  const entry = linkCodes.get(String(code || '').toUpperCase());
  if (!entry || entry.expires < Date.now()) return { ok: false, reason: 'Код недійсний або застарів. Створіть новий у програмі.' };
  const user = db.prepare('SELECT id, name, active FROM users WHERE id = ?').get(entry.userId);
  if (!user || !user.active) return { ok: false, reason: 'Обліковий запис недоступний.' };
  const chatId = String(chat.id);
  const other = db.prepare('SELECT name FROM users WHERE tg_chat_id = ? AND id <> ?').get(chatId, user.id);
  if (other) return { ok: false, reason: 'Цей Telegram уже прив\'язано до іншого користувача.' };
  db.prepare('UPDATE users SET tg_chat_id = ?, tg_username = ? WHERE id = ?').run(chatId, chat.username || null, user.id);
  linkCodes.delete(String(code).toUpperCase());
  return { ok: true, name: user.name };
}

async function handleUpdate(u) {
  const m = u.message;
  if (!m || !m.chat || m.chat.type !== 'private' || typeof m.text !== 'string') return;
  const text = m.text.trim();
  const mm = /^\/start(?:@\w+)?\s+(\S+)$/i.exec(text) || /^([A-Fa-f0-9]{10})$/.exec(text);
  if (!mm) {
    const linked = db.prepare('SELECT name FROM users WHERE tg_chat_id = ?').get(String(m.chat.id));
    await sendMessage(m.chat.id, linked
      ? `Цей чат прив'язано до облікового запису «${linked.name}». Сюди приходитимуть коди входу в AV_fleetOS.`
      : 'Це бот підтвердження входу в AV_fleetOS. Щоб прив\'язати Telegram, відкрийте програму й натисніть «Прив\'язати Telegram».');
    return;
  }
  const res = linkChat(mm[1], m.chat);
  await sendMessage(m.chat.id, res.ok
    ? `✅ Telegram прив'язано до облікового запису «${res.name}». Тепер коди входу в AV_fleetOS приходитимуть сюди.`
    : `⚠️ ${res.reason}`);
}

let polling = false;
async function pollLoop() {
  let offset = 0;
  while (polling) {
    try {
      const updates = await api('getUpdates', { offset, timeout: 25, allowed_updates: ['message'] }, 40000);
      for (const u of updates) {
        offset = u.update_id + 1;
        try { await handleUpdate(u); } catch (e) { console.error('[telegram] update error:', e.message); }
      }
    } catch (e) {
      console.error('[telegram] polling error:', e.message);
      await new Promise(r => setTimeout(r, e.status === 409 ? 30000 : 5000));
    }
  }
}
function startPolling() {
  if (!enabled() || polling) return;
  polling = true;
  getBotUsername();
  pollLoop();
  console.log('[telegram] two-step login is ON (bot polling started)');
}
function stopPolling() { polling = false; }

module.exports = { enabled, sendMessage, getBotUsername, createLinkCode, linkChat, startPolling, stopPolling };
