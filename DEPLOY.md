# AV_fleetOS — Інструкція розгортання на сервері

## 1. Підключення до сервера

```bash
ssh root@ВАШ_IP_СЕРВЕРА
```

## 2. Встановлення Node.js

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs
node --version   # має показати v20.x.x
```

## 3. Завантаження AV_fleetOS

```bash
mkdir -p /var/www/AV_fleetOS
cd /var/www/AV_fleetOS
```

Завантажте архів через SFTP (FileZilla або WinSCP), або:
```bash
# Якщо файли вже на сервері — перейдіть до кроку 4
```

## 4. Встановлення залежностей

```bash
cd /var/www/AV_fleetOS
npm install
```

## 5. Налаштування

```bash
cp .env.example .env
nano .env
```

Заповніть:
```
PORT=3000
JWT_SECRET=ваш_довгий_секретний_рядок_мінімум_32_символи
ADMIN_USERNAME=admin
ADMIN_PASSWORD=ВАШ_НАДІЙНИЙ_ПАРОЛЬ
ADMIN_NAME=Ваше Імʼя
```

## 6. Тестовий запуск

```bash
node server.js
```

Відкрийте в браузері: `http://ВАШ_IP:3000`

## 7. Постійна робота (PM2)

```bash
npm install -g pm2
pm2 start server.js --name AV_fleetOS
pm2 startup
pm2 save
```

## 8. Домен і HTTPS (необов'язково але рекомендовано)

```bash
sudo apt install nginx certbot python3-certbot-nginx -y
```

Конфіг `/etc/nginx/sites-available/AV_fleetOS`:
```nginx
server {
    server_name ВАШ_ДОМЕН.com;
    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
```

```bash
sudo ln -s /etc/nginx/sites-available/AV_fleetOS /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d ВАШ_ДОМЕН.com
```

## 9. Резервні копії

Завантажити копію бази даних:
```
GET https://ВАШ_ДОМЕН.com/api/backup
```
(тільки для Адміна, потрібна авторизація)

Або просто скопіювати файл:
```bash
cp /var/www/AV_fleetOS/AV_fleetOS.db /backup/AV_fleetOS-$(date +%Y%m%d).db
```

## Корисні команди

```bash
pm2 status          # стан сервера
pm2 logs AV_fleetOS    # логи
pm2 restart AV_fleetOS # перезапуск
```
