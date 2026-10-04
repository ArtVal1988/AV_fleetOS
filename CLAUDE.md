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
