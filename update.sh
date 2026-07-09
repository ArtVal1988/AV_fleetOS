#!/bin/bash
# AV_fleetOS — скрипт оновлення з GitHub
set -e

REPO_DIR="/var/www/AV_fleetOS"
SERVICE="AV_fleetOS"

echo "🔄 Оновлення AV_fleetOS..."

cd $REPO_DIR
git pull origin main

# Sync public folder
cp -r public/* /var/www/AV_fleetOS-server/public/

# Sync server files
cp -r server/* /var/www/AV_fleetOS-server/

# Install any new dependencies
cd /var/www/AV_fleetOS-server
npm install --production > /dev/null 2>&1

# Restart
pm2 restart $SERVICE

sleep 2
STATUS=$(curl -s http://localhost:3000/api/health | python3 -c "import sys,json; print(json.load(sys.stdin).get('status','?'))" 2>/dev/null)

if [ "$STATUS" = "ok" ]; then
    echo "✅ AV_fleetOS оновлено і запущено"
else
    echo "❌ Помилка після оновлення — перевірте: pm2 logs AV_fleetOS"
fi
