#!/bin/bash
# AV_fleetOS — ПОВНИЙ бекап ОСНОВИ (production) перед оновленням.
# Нічого не зупиняє і не змінює на основі: база копіюється через VACUUM INTO (безпечно «на ходу»).
# Що потрапляє в бекап (папка /root/backups/prod-<дата-час>):
#   AV_fleetOS.db    — вся база (графік, замовлення, авто, клієнти, налаштування, користувачі, журнал дій)
#   uploads.tar.gz   — усі файли (документи авто, клієнтів, фото, страхові справи)
#   code.tar.gz      — поточний код основи (без node_modules і uploads)
#   env.backup       — файл .env (секрети! папка доступна лише root)
#   INFO.txt, RESTORE.txt — що це за копія і як відновити
set -e
PROD_DIR="${PROD_DIR:-/var/www/AV_fleetOS-server}"
BACKUP_ROOT="${BACKUP_ROOT:-/root/backups}"
STAMP=$(date +%Y%m%d-%H%M%S)
OUT="$BACKUP_ROOT/prod-$STAMP"

resolve_db() {
    local dir="$1" p=""
    [ -f "$dir/.env" ] && p=$(grep -E '^DB_PATH=' "$dir/.env" | tail -1 | cut -d= -f2- | tr -d '"' | tr -d "'" | tr -d '\r')
    [ -z "$p" ] && p="./AV_fleetOS.db"
    case "$p" in /*) echo "$p";; *) echo "$dir/${p#./}";; esac
}
PROD_DB="${PROD_DB:-$(resolve_db "$PROD_DIR")}"
[ -f "$PROD_DB" ] || { echo "❌ Не знайдено базу основи: $PROD_DB"; exit 1; }

# Скільки останніх бекапів prod-* зберігати (старіші видаляються автоматично) і мінімум вільного місця (МБ)
KEEP="${KEEP:-3}"
MIN_FREE_MB="${MIN_FREE_MB:-2500}"

umask 077
mkdir -p "$BACKUP_ROOT"

# 0) Місце на диску: спершу прибираємо найстаріші prod-* (лишаємо KEEP-1, щоб разом з новим було KEEP)
PRUNE_KEEP=$((KEEP-1)); [ "$PRUNE_KEEP" -lt 1 ] && PRUNE_KEEP=1
ls -1d "$BACKUP_ROOT"/prod-* 2>/dev/null | sort | head -n -"$PRUNE_KEEP" | while read -r old; do
    echo "🧹 Видаляю старий бекап: $old"; rm -rf "$old"
done
FREE_MB=$(df -Pm "$BACKUP_ROOT" | awk 'NR==2{print $4}')
if [ "$FREE_MB" -lt "$MIN_FREE_MB" ]; then
    echo "❌ Мало місця на диску: вільно ${FREE_MB} МБ, потрібно щонайменше ${MIN_FREE_MB} МБ. Бекап НЕ створено."
    echo "   Звільни місце (наприклад, старі бекапи у $BACKUP_ROOT) і запусти ще раз."
    exit 1
fi

# Якщо бекап обірвався (наприклад, закінчилось місце) — неповну папку видаляємо, щоб її не сприйняли за робочу
BACKUP_OK=0
cleanup_incomplete() { [ "$BACKUP_OK" = "1" ] || { echo "❌ Бекап не завершився — неповну папку видаляю: $OUT"; rm -rf "$OUT"; }; }
trap cleanup_incomplete EXIT
mkdir -p "$OUT"
echo "ОСНОВА : $PROD_DIR"
echo "БАЗА   : $PROD_DB"
echo "БЕКАП  : $OUT"
echo

# 1) База
cd "$PROD_DIR"
PROD_DB="$PROD_DB" OUT_DB="$OUT/AV_fleetOS.db" node -e "
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync(process.env.PROD_DB);
db.exec(\"VACUUM INTO '\" + process.env.OUT_DB.replace(/'/g, \"''\") + \"'\");
const c = new DatabaseSync(process.env.OUT_DB);
const n = t => { try { return c.prepare('SELECT COUNT(*) n FROM '+t).get().n; } catch(e) { return '—'; } };
const ic = c.prepare('PRAGMA integrity_check').get();
console.log('✅ База скопійована: замовлень', n('bookings'), '| авто', n('vehicles'), '| клієнтів', n('clients'), '| стікерів', n('stickers'));
console.log('   Перевірка цілісності:', Object.values(ic)[0]);
" 2>&1 | grep -v ExperimentalWarning | grep -v "node --trace-warnings"

# 2) Файли
if [ -d "$PROD_DIR/uploads" ]; then
    tar czf "$OUT/uploads.tar.gz" -C "$PROD_DIR" uploads
    echo "✅ Файли (uploads): $(du -h "$OUT/uploads.tar.gz" | cut -f1), файлів: $(find "$PROD_DIR/uploads" -type f | wc -l)"
else
    echo "ℹ️  Папки uploads немає — пропущено"
fi

# 3) Код і .env
tar czf "$OUT/code.tar.gz" -C "$PROD_DIR" --exclude=node_modules --exclude=uploads --exclude='*.db' --exclude='*.db-wal' --exclude='*.db-shm' --exclude='*.bak-*' .
echo "✅ Код основи: $(du -h "$OUT/code.tar.gz" | cut -f1)"
[ -f "$PROD_DIR/.env" ] && cp "$PROD_DIR/.env" "$OUT/env.backup" && echo "✅ .env збережено"

# 4) Опис і інструкція відновлення
GIT_HEAD=$(git -C /var/www/AV_fleetOS rev-parse --short HEAD 2>/dev/null || echo "?")
cat > "$OUT/INFO.txt" <<EOT
Бекап основи AV_fleetOS
Створено : $(date '+%d.%m.%Y %H:%M:%S')
Сервер   : $PROD_DIR
База     : $PROD_DB
Версія коду (git, /var/www/AV_fleetOS): $GIT_HEAD
EOT
cat > "$OUT/RESTORE.txt" <<EOT
ВІДНОВЛЕННЯ БАЗИ (якщо після оновлення щось пішло не так):
  pm2 stop AV_fleetOS
  cp "$PROD_DB" "$PROD_DB.before-restore-\$(date +%Y%m%d-%H%M%S)"
  rm -f "$PROD_DB-wal" "$PROD_DB-shm"
  cp "$OUT/AV_fleetOS.db" "$PROD_DB"
  pm2 start AV_fleetOS

ВІДНОВЛЕННЯ ФАЙЛІВ (тільки якщо зникли документи/фото):
  tar xzf "$OUT/uploads.tar.gz" -C "$PROD_DIR"

ВІДНОВЛЕННЯ КОДУ (відкат версії):
  tar xzf "$OUT/code.tar.gz" -C "$PROD_DIR" && pm2 restart AV_fleetOS
EOT
BACKUP_OK=1
echo
echo "🎉 Готово. Папка бекапу: $OUT"
echo "   Розмір: $(du -sh "$OUT" | cut -f1)   |   Як відновити: cat $OUT/RESTORE.txt"
