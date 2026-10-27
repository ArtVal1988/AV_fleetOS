# AV_fleetOS — deployment workflow

The user (Artem) communicates in Ukrainian and expects responses in Ukrainian.
`public/index.html` is a large single-file frontend (inline `<script>`/`<style>`);
`server/routes/*.js` is the Express backend.

## Deploying a change (current, simplified workflow)

1. Edit `public/index.html` (or `server/routes/*.js`).
2. Validate JS syntax before committing: extract every `<script>` block from
   `index.html`, concatenate, and run `node --check` on the result.
3. `git add` + `git commit`, using a detailed English commit message and
   ending with the attribution footer from the session's system reminder
   (varies by session — don't hardcode one here).
4. `git push origin main`.
5. Tell the user it's pushed and give the commands as **separate, copyable code
   blocks**. The user runs them on the server themselves (Claude has no SSH
   access) in TWO steps — test first, production only after they confirm:

   **Step 1 — TEST site only** (http://173.242.58.173:3003, its own separate
   database; `/root/update-temp.sh` does `git pull` itself, copies public/ and
   server/ into `/var/www/AV_fleetOS-temp`, runs `npm install` and
   `pm2 restart AV_fleetOS-temp`, so backend changes apply there automatically;
   it never touches production):

   ```bash
   bash /root/update-temp.sh
   ```

   **Step 2 — PRODUCTION, only after the user says the test site is OK:**

   ```bash
   bash /root/update.sh && bash /root/verify-deploy.sh prod
   ```

   For backend (`server/*.js`) changes add `&& pm2 restart AV_fleetOS` to the
   production command (check with `pm2 status AV_fleetOS`). Frontend-only
   changes also need a browser hard refresh (Ctrl+Shift+R).
   If the user explicitly asks to skip testing for a small change, the old
   one-liner is fine: `bash /root/update.sh && bash /root/verify-deploy.sh prod && bash /root/update-temp.sh`.
   Do not revive the old OneDrive/adm.tools manual upload ritual unless
   `git push` is broken and the user asks for a fallback.

## If `git push` fails with "access denied by the git proxy" / 403

This cloud session's git proxy will not inject a GitHub credential for this
repo (`ArtVal1988/AV_fleetOS` is not in "this session's authorized
repository set"). The proxy hard-rejects (403, non-retriable) git's normal
first, unauthenticated probe request — so a credential helper or a token
embedded in the remote URL never gets a chance to kick in, because git only
offers those on a 401 challenge, which never arrives.

Fix: ask the user for a fresh GitHub Personal Access Token (repo scope) and
force the Authorization header onto every request, including the first one,
via a **repo-local** (not global) git config:

```bash
cd /home/claude/AV_fleetOS
AUTH=$(printf 'x-access-token:%s' "$GH_TOKEN" | base64 -w0)
git config http.extraheader "Authorization: Basic ${AUTH}"
```

Notes:
- This must be set again in any **new** session/container — `.git/config` is
  local to the checkout and is never committed or pushed, so a fresh clone
  starts without it.
- Never commit the token anywhere, never print it back to the user, and
  never put it in this file.
- A URL-embedded token (`https://x-access-token:TOKEN@github.com/...`) and
  `git config credential.helper store` were both tried and do **not** work
  here — only the `http.extraheader` approach gets past the proxy's
  first-request block.

## Working with the user (Artem)

- Always answer in **Ukrainian** (he is learning English). Refer to yourself in
  the **masculine** form ("зробив", "перевірив", "запушив") — he asked to keep the
  earlier manner. He is not a developer: short, concrete steps; every server
  command in its own copyable code block.
- Never commit/print the GitHub token (see section above).
- Before saying something works, test it (Playwright is available at
  `/opt/pw-browsers/chromium`; open `public/index.html` via `file://` and hide
  `#login-overlay`, or serve it on a local port).

## Environments

| | Production | Test (TEMP) |
|---|---|---|
| Address | av-fcs.com (port 3000) | http://173.242.58.173:3003 |
| Folder | `/var/www/AV_fleetOS-server` | `/var/www/AV_fleetOS-temp` |
| Database | real data | **separate** database |
| pm2 process | `AV_fleetOS` | `AV_fleetOS-temp` |
| Update | `/root/update.sh` (+ `pm2 restart AV_fleetOS` for backend changes) | `/root/update-temp.sh` (restarts itself) |

- `/var/www/AV_fleetOS` is only the git clone both sites copy from.
- `deploy/update-temp-ref.sh <branch|tag|commit>` puts any git version on TEMP
  (code only; DB/.env/uploads untouched) and verifies the index.html md5.
  `... main` returns TEMP to the current main.
- `deploy/copy-prod-db-to-temp.sh` replaces the TEMP database with a full copy of the PROD database
  (VACUUM INTO; PROD untouched; old TEMP db kept as `.bak-<time>`; uploads not copied).
  Run: `bash /var/www/AV_fleetOS/deploy/copy-prod-db-to-temp.sh` (after `bash /root/update-temp.sh` so the clone is current).
- `PROJECT_NOTES.md` still describes an older "staging :3001" setup — outdated;
  TEMP :3003 replaced it.
- **One code line**: both sites run the same `main`. Test-only behaviour is
  decided at run time by `location.port === '3003'` (never by branches), so
  bug fixes reach production unchanged and nothing has to be stripped on release.

## Run-time test-site features (port 3003 only)

- Striped bar + "🧪 ТЕСТОВИЙ САЙТ" tag + title prefix (script at the end of
  `index.html`).
- **Early return (ДП, "Дострокове повернення")** — individuals only, lives in the
  «Утримання» panel of the booking modal. Gated by `earlyReturnEnabled()`; on
  production it is dormant (user wants to test it first). To launch it for
  everyone, remove the port condition in `earlyReturnEnabled()`.
  Model: `b.end` = actual return date; `b.daysOverride` = billed days (frozen,
  editable for partial refunds); `b.earlyReturn = {active, plannedEnd,
  plannedDays}`. Calendar shows paid-but-free days as hatched empty cells
  (`buildEarlyReturnCellMap`). Reports need no change
  (`resolveBookingDaySegments` already bills days past the recorded end).
  Branches `early-return-test` / `early-return-full` are old snapshots (backup).

## Other features added in this period (so they are not re-invented)

- Client card is split into 4 coloured blocks (`.cf-block .cf-b1..b4`);
  address field sits at the bottom of the Passport block; delete button is
  admin-only (UI + server 403 → backend change needs `pm2 restart`).
- Client documents: multi-file upload, download name
  "ПІБ - Паспорт|ІПН|Водійське|Інше[ N].ext", desktop download without the OS share
  sheet, **crop** (`POST /api/client-documents/:id/crop`) and **straighten**
  (`.../straighten`) tools in the attachment viewer — server side, so they need
  `pm2 restart`. Uploads are compressed on the server (max 2400 px, quality 85) — kept as is.
- Admin popup when another user deletes a booking, with "Відновити" (reuses
  `POST /api/activity-log/:id/undo`); frontend polls every 60 s; seen-state is per
  admin in localStorage.
- Booking payment form / deposit form start **empty** (no cash default);
  mandatory only for status «В оренді» (main form skipped for business clients,
  deposit form required only if a deposit amount is set). Mixed-payment icon
  uses `#749190`.
- Notes are stored as one string; a note starts with `[Автор · дата]`, extra
  lines (Shift+Enter) belong to the previous note (`splitNotesEntries`).
- Date/time fields: manual typing works site-wide; New-booking date display
  fields accept digits only and auto-insert dots.

## Telegram two-step login (server/telegram.js, routes/auth.js)

- Needs `TELEGRAM_BOT_TOKEN` in the site's `.env` (prod: `/var/www/AV_fleetOS-server/.env`,
  test: `/var/www/AV_fleetOS-temp/.env`). **Use a different bot per site** — the server
  long-polls `getUpdates`, and two processes polling one bot conflict (409).
- Without a token (or with `TG_2FA_DISABLED=1` — emergency switch, then
  `pm2 restart`) login works as before. Requires a pm2 restart after editing `.env`.
- Flow: password OK → if the user has a linked chat, a 6-digit code (5 min, 5 attempts,
  in memory) goes to Telegram and `POST /auth/login/verify` issues the token. Users
  without a linked chat get a mandatory "link Telegram" overlay after login
  (`/auth/telegram/link-code` + deep link `t.me/<bot>?start=<code>`); admin can reset a
  user's link in «Користувачі» (`PUT /auth/users/:id {tgReset:true}`).
- Change-password verifies the old password via `POST /auth/check-password`
  (never `/auth/login`, which would send a code).
- Columns `users.tg_chat_id`, `users.tg_username` (added by `ensureColumn`).
- **Owner mode** (`TG_OWNER_USERNAME=<login>` in `.env`, used on prod): every login
  code (for all users) is sent to the OWNER's Telegram only, with the name/login/IP of
  whoever is logging in; the owner passes the code on. Only the owner links Telegram
  (mandatory overlay for him). While the owner has no linked chat, only the owner can log in
  (503 for everybody else) so the check is never silently skipped. Only the owner can reset
  his own link. Without this variable each user gets codes in their own Telegram.

## Activity log («Журнал дій», admin only)

- Table `activity_log` (+ columns `details` JSON = list of changes, `ip`). Written ONLY via
  `server/activityLog.js`: `logReq(req, {action, entityType, entityId, summary, snapshot, details})`.
  `logReq`/`diffData` never throw — logging must never break the real operation.
- `diffData(before, after, labels)` produces `{label, from, to}` / `{label, added[], removed[]}`;
  label maps per entity (`BOOKING_LABELS`, `CLIENT_LABELS`, `VEHICLE_LABELS`, ...). An update with
  no real change is NOT logged. Noise keys are in `SKIP_KEYS`.
- Logged: bookings (incl. repair pause, payments, notes), clients, vehicles (incl. `works` = repairs),
  vehicle/client documents, insurance-case files, spare parts, stickers, settings, users, document
  templates/mapping, generated contracts/acts, login / logout / failed login, Telegram link.
  `server.js` has a safety net for any future mutating `/api` route that does not log itself
  (add the new router prefix to `SELF_LOGGING` there once it logs explicitly).
- Entity types: booking, client, vehicle, vehicle_doc, client_doc, case_file, spare_part, sticker,
  generated_doc, template, setting, user, auth, other (UI labels in `AL_ENTITY` in index.html).
- Undo exists only for `booking` entries (needs `snapshot`).
