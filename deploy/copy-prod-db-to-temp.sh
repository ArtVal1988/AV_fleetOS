#!/bin/bash
# AV_fleetOS — повна копія бази даних ОСНОВИ → ТЕСТОВИЙ сайт (3003).
# Основний сайт нічого не змінюється (VACUUM INTO — безпечна копія «на ходу», сайт не зупиняється).
# База тестового сайту ПОВНІСТЮЧЕ замінюється (стара зберігається як резервна копія).
# Файли (uploads: фото документів клієнтів) НЕ копіюються.
set -e
PROD_DIR="${PROD_DIR:-/var/www/AV_fleetOS-server}"
TEMP_DIR="${TEMP_DIR:-/var/www/AV_fleetOS-temp}"

resolve_db() { # $1 = папка сайту → абсолютний шлях до файлу бази
    local dir="$1" p=""
    [ -f "$dir/.env" ] && p=$(grep -E '^DB_PATH=' "$dir/.env" | tail -1 | cut -d= -f2- | tr -d '"' | tr -d "'" | tr -d '\r')
    [ -z "$p" ] && p="./AV_fleetOS.db"
    case "$p" in /*) echo "$p";; *) echo "$dir/${p#./}";; esac
}
PROD_DB=$(resolve_db "$PROD_DIR")
TEMP_DB=$(resolve_db "$TEMP_DIR")
[ -f "$PROD_DB" ] || { echo "❌ Не знайдено базу основи: $PROD_DB"; exit 1; }
[ "$PROD_DB" != "$TEMP_DB" ] || { echo "❌ Шляхи баз збігаються — зупинено, щоб не зіпсувати основу"; exit 1; }
echo "ОСНОВА : $PROD_DB"
echo "ТЕСТ   : $TEMP_DB"

NEW=$(mktemp -u "$TEMP_DIR/.prod-copy-XXXXXX.db")
cd "$PROD_DIR"
PROD_DB="$PROD_DB" NEW="$NEW" node -e "
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync(process.env.PROD_DB);
db.exec(\"VACUUM INTO '\" + process.env.NEW.replace(/'/g, \"''\") + \"'\");
const c = new DatabaseSync(process.env.NEW);
console.log('Скопійовано: замовлень', c.prepare('SELECT COUNT(*) n FROM bookings').get().n,
  '| авто', c.prepare('SELECT COUNT(*) n FROM vehicles').get().n,
  '| клієнтів', c.prepare('SELECT COUNT(*) n FROM clients').get().n);
"

pm2 stop AV_fleetOS-temp >/dev/null
if [ -f "$TEMP_DB" ]; then
    BK="$TEMP_DB.bak-$(date +%Y%m%d-%H%M%S)"
    cp "$TEMP_DB" "$BK"; echo "🗂  Стара тестова база збережена: $BK"
fi
rm -f "$TEMP_DB-wal" "$TEMP_DB-shm"
mv "$NEW" "$TEMP_DB"
pm2 start AV_fleetOS-temp >/dev/null
sleep 2
STATUS=$(curl -s http://localhost:3003/api/health | python3 -c "import sys,json; print(json.load(sys.stdin).get('status','?'))" 2>/dev/null)
if [ "$STATUS" = "ok" ]; then echo "✅ Тестовий сайт працює з копією бази основи: http://173.242.58.173:3003"
else echo "❌ Перевірте: pm2 logs AV_fleetOS-temp"; fi
