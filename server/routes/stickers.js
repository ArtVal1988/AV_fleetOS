const router = require('express').Router();
const db = require('../db');
const { auth } = require('./auth');
const { logReq, diffData, changedLabels, STICKER_LABELS } = require('../activityLog');

function stickerSummary(s) {
  const text = (s.text || '').trim();
  return text.length > 60 ? text.slice(0, 60) + '…' : (text || s.title || '');
}

// Who wrote / changed what is stamped HERE from the logged-in user and the
// server clock — the client cannot choose the name or time.
const userLabel = (req) => req.user?.name || req.user?.username || '';
const nowIso = () => new Date().toISOString();
const sqliteToIso = (v) => (v ? String(v).replace(' ', 'T') + 'Z' : null);

function stampNewComments(comments, user, now) {
  return (Array.isArray(comments) ? comments : []).map(c => ({
    text: c.text, author: user, date: now,
  }));
}

// Merge the client's version of a sticker with what is stored: author/created
// stay as they were, and every new or changed piece gets the current user + time.
function stampUpdate(body, before, user, now) {
  const data = { ...body };
  data.author = before.author || user;
  data.createdAt = before.createdAt || now;
  if (before.createdBy !== undefined) data.createdBy = before.createdBy;
  const changed = ['title', 'text', 'color'].some(k => (body[k] ?? '') !== (before[k] ?? ''));
  data.editedBy = changed ? user : before.editedBy;
  data.editedAt = changed ? now : before.editedAt;

  const old = new Map((before.comments || []).map(c => [c.date, c]));
  data.comments = (Array.isArray(body.comments) ? body.comments : []).map(c => {
    // Legacy comments may have no date: match those by text so they are not re-stamped.
    const prev = (c.date && old.get(c.date)) || (!c.date && (before.comments || []).find(p => !p.date && p.text === c.text));
    if (!prev) return { text: c.text, author: user, date: now };       // new comment
    if ((c.text ?? '') === (prev.text ?? '')) return prev;              // untouched
    return { ...prev, text: c.text, edited: true, editedBy: user, editedAt: now };
  });
  return data;
}

router.get('/', auth, (req, res) => {
  const rows = db.prepare('SELECT * FROM stickers ORDER BY created_at ASC').all();
  res.json(rows.map(r => {
    const d = JSON.parse(r.data);
    return { ...d, createdAt: d.createdAt || sqliteToIso(r.created_at), id: r.id };
  }));
});

router.post('/', auth, (req, res) => {
  const now = nowIso();
  const user = userLabel(req);
  const data = { ...req.body, author: user, createdBy: req.user?.id ?? null, createdAt: now,
    comments: stampNewComments(req.body.comments, user, now) };
  delete data.id;
  const result = db.prepare('INSERT INTO stickers (data) VALUES (?)').run(JSON.stringify(data));
  logReq(req, {
    action: 'create', entityType: 'sticker', entityId: result.lastInsertRowid,
    summary: stickerSummary(data), snapshot: { ...data, id: result.lastInsertRowid },
    userName: user,
  });
  res.status(201).json({ id: result.lastInsertRowid, author: data.author, createdAt: data.createdAt });
});

router.put('/:id', auth, (req, res) => {
  const row = db.prepare('SELECT id, data FROM stickers WHERE id = ?').get(req.params.id);
  const before = row ? JSON.parse(row.data) : null;
  const data = before ? stampUpdate(req.body, before, userLabel(req), nowIso()) : { ...req.body };
  delete data.id;
  db.prepare('UPDATE stickers SET data = ? WHERE id = ?').run(JSON.stringify(data), req.params.id);
  const changes = diffData(before, data, STICKER_LABELS);
  if (changes.length) {
    logReq(req, {
      action: 'update', entityType: 'sticker', entityId: req.params.id,
      summary: `${stickerSummary(data)} — ${changedLabels(changes)}`,
      snapshot: { before, after: { ...data, id: Number(req.params.id) } },
      details: changes, userName: userLabel(req),
    });
  }
  res.json({ ok: true, sticker: { ...data, id: Number(req.params.id) } });
});

router.delete('/:id', auth, (req, res) => {
  const row = db.prepare('SELECT id, data FROM stickers WHERE id = ?').get(req.params.id);
  const deletedData = row ? { ...JSON.parse(row.data), id: row.id } : null;
  db.prepare('DELETE FROM stickers WHERE id = ?').run(req.params.id);
  logReq(req, {
    action: 'delete', entityType: 'sticker', entityId: req.params.id,
    summary: deletedData ? stickerSummary(deletedData) : null, snapshot: deletedData,
  });
  res.json({ ok: true });
});

module.exports = router;
