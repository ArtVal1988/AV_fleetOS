#!/bin/bash
# AV_fleetOS — повне оновлення TEMP (порт 3003) із ВКАЗАНОЇ версії git
# (гілка, тег або коміт), без зміни основного сайту і без зміни гілки main.
#
#   bash /var/www/AV_fleetOS/deploy/update-temp-ref.sh early-return-test
#   bash /var/www/AV_fleetOS/deploy/update-temp-ref.sh main        # повернути поточну версію
#
# Копіюється код (public/, routes, server.js, db.js, package.json, activityLog.js).
# База даних, .env та файли (uploads) тестового сайту НЕ чіпаються.
set -e
REPO_DIR="${REPO_DIR:-/var/www/AV_fleetOS}"
TEMP_DIR="${TEMP_DIR:-/var/www/AV_fleetOS-temp}"
REF="${1:-main}"

cd "$REPO_DIR"
git fetch origin --tags --prune
if git rev-parse --verify -q "origin/$REF" >/dev/null; then REF_FULL="origin/$REF"; else REF_FULL="$REF"; fi
if ! git rev-parse --verify -q "$REF_FULL^{commit}" >/dev/null; then
    echo "❌ Не знайдено версію: $REF"; exit 1
fi
echo "🔄 TEMP ← $REF ($(git rev-parse --short "$REF_FULL")): $(git log -1 --format=%s "$REF_FULL" | cut -c1-70)"

STAGE=$(mktemp -d)
trap 'rm -rf "$STAGE"' EXIT
git archive "$REF_FULL" public server | tar -x -C "$STAGE"

mkdir -p "$TEMP_DIR/public" "$TEMP_DIR/routes"
cp -r "$STAGE/public/." "$TEMP_DIR/public/"
cp -r "$STAGE/server/routes/." "$TEMP_DIR/routes/"
cp "$STAGE/server/server.js" "$STAGE/server/db.js" "$STAGE/server/package.json" "$STAGE/server/activityLog.js" "$TEMP_DIR/"

# Перевірка: файл на тестовому сайті ідентичний версії з git
WANT=$(git show "$REF_FULL:public/index.html" | md5sum | cut -d' ' -f1)
HAVE=$(md5sum "$TEMP_DIR/public/index.html" | cut -d' ' -f1)
if [ "$WANT" = "$HAVE" ]; then echo "✅ index.html збігається з версією $REF"; else echo "❌ index.html НЕ збігається з версією $REF"; exit 1; fi

if [ -n "$DRY_RUN" ]; then echo "(DRY_RUN: npm install / pm2 restart пропущено)"; exit 0; fi

cd "$TEMP_DIR"
npm install --production --prefer-offline --no-audit --no-fund
pm2 restart AV_fleetOS-temp
sleep 2
STATUS=$(curl -s http://localhost:3003/api/health | python3 -c "import sys,json; print(json.load(sys.stdin).get('status','?'))" 2>/dev/null)
if [ "$STATUS" = "ok" ]; then
    echo "✅ TEMP запущено: http://173.242.58.173:3003  (версія: $REF)"
else
    echo "❌ Помилка — перевірте: pm2 logs AV_fleetOS-temp"
fi
