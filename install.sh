#!/bin/bash
# AV_fleetOS — перше розгортання на сервері
set -e

GITHUB_REPO="https://github.com/ArtVal1988/AV_fleetOS.git"
INSTALL_DIR="/var/www/AV_fleetOS-server"
REPO_DIR="/var/www/AV_fleetOS"

echo "=================================================="
echo "  AV_fleetOS — Автоматичне розгортання"
echo "=================================================="

# 1. Node.js 22
echo "▶ 1/7 Встановлення Node.js 22..."
curl -fsSL https://deb.nodesource.com/setup_22.x | bash - > /dev/null 2>&1
apt-get install -y nodejs git > /dev/null 2>&1
echo "   Node.js $(node --version) ✅"

# 2. PM2
echo "▶ 2/7 Встановлення PM2..."
npm install -g pm2 > /dev/null 2>&1
echo "   PM2 $(pm2 --version) ✅"

# 3. Clone repo
echo "▶ 3/7 Завантаження коду з GitHub..."
rm -rf $REPO_DIR
git clone $GITHUB_REPO $REPO_DIR > /dev/null 2>&1
echo "   Код завантажено ✅"

# 4. Setup server folder
echo "▶ 4/7 Налаштування папки сервера..."
mkdir -p $INSTALL_DIR/public
cp -r $REPO_DIR/server/* $INSTALL_DIR/
cp -r $REPO_DIR/public/* $INSTALL_DIR/public/
echo "   Файли скопійовано ✅"

# 5. Install dependencies
echo "▶ 5/7 Встановлення залежностей..."
cd $INSTALL_DIR
npm install --production > /dev/null 2>&1
echo "   npm install ✅"

# 6. Create .env
echo "▶ 6/7 Налаштування конфігурації..."
JWT_SECRET=$(node -e "console.log(require('crypto').randomBytes(48).toString('hex'))")
cat > $INSTALL_DIR/.env << ENV
PORT=3000
JWT_SECRET=${JWT_SECRET}
JWT_EXPIRES_IN=30d
DB_PATH=./AV_fleetOS.db
ADMIN_USERNAME=admin
ADMIN_PASSWORD=admin123
ADMIN_NAME=Адміністратор
ENV
echo "   .env створено ✅"

# 7. Start
echo "▶ 7/7 Запуск..."
cd $INSTALL_DIR
pm2 delete AV_fleetOS 2>/dev/null || true
pm2 start "node --experimental-sqlite server.js" --name AV_fleetOS
pm2 startup 2>/dev/null | grep "sudo" | bash > /dev/null 2>&1 || true
pm2 save > /dev/null 2>&1

# Copy update script
cp $REPO_DIR/update.sh /root/update.sh
chmod +x /root/update.sh
# Replace placeholder with actual token in update script
sed -i "s|https://github.com|https://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@github.com|g" $REPO_DIR/.git/config

sleep 3
STATUS=$(curl -s http://localhost:3000/api/health | python3 -c "import sys,json; print(json.load(sys.stdin).get('status','?'))" 2>/dev/null)

echo ""
echo "=================================================="
if [ "$STATUS" = "ok" ]; then
    echo "  ✅ AV_fleetOS успішно запущено!"
    echo ""
    echo "  🌐 http://173.242.58.173:3000"
    echo "  👤 Логін:  admin"
    echo "  🔑 Пароль: admin123"
    echo ""
    echo "  🔄 Для оновлень надалі: bash /root/update.sh"
else
    echo "  ❌ Помилка. Перевірте: pm2 logs AV_fleetOS"
fi
echo "=================================================="
