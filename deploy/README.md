# SyncPlay — автоматический деплой на VPS

Эта папка содержит скрипт и шаблоны для развёртывания SyncPlay на сервере с Ubuntu 22.04 одной командой.

## Быстрый старт

### 1. Подготовьте VPS
Закажите у любого российского провайдера (TimeWeb, Selectel, RuVDS, Yandex Cloud, BeGet):
- **OS**: Ubuntu 22.04 LTS
- **Минимум**: 1 vCPU / 1 ГБ RAM / 20 ГБ SSD
- **Открытые порты**: 22 (SSH), 80 (HTTP), 443 (HTTPS)

### 2. Подключитесь по SSH
```bash
ssh root@<ваш-ip>
```

### 3. Запустите скрипт
**Вариант A — напрямую из вашего GitHub:**
```bash
wget https://raw.githubusercontent.com/<вы>/syncplay/main/deploy/deploy.sh
sudo bash deploy.sh
```

**Вариант B — клонировав репозиторий локально:**
```bash
git clone https://github.com/<вы>/syncplay.git
cd syncplay
sudo bash deploy/deploy.sh
```

### 4. Ответьте на вопросы скрипта
Скрипт спросит:
- Откуда брать код (git или локальная папка)
- Доменное имя (например, `syncplay.ru`) — необязательно
- E-mail для Let's Encrypt — если хотите HTTPS

И всё. Через 3–5 минут приложение работает по адресу `http://<ваш-ip>` или `https://syncplay.ru`.

---

## Что делает скрипт

| Шаг | Действие |
|---|---|
| 1 | Установка `python3.11`, `nodejs 20`, `yarn`, `nginx`, `ufw`, `git` |
| 2 | Установка и запуск MongoDB 7 (из официального репозитория) |
| 3 | Создание системного пользователя `syncplay` |
| 4 | Клонирование репозитория в `/opt/syncplay` |
| 5 | Создание Python venv, установка зависимостей backend |
| 6 | Генерация `backend/.env` (MONGO_URL, DB_NAME, CORS_ORIGINS) |
| 7 | Генерация `frontend/.env` (REACT_APP_BACKEND_URL) и `yarn build` |
| 8 | Создание systemd-сервиса `syncplay.service` для бэкенда |
| 9 | Настройка Nginx с поддержкой WebSocket и HTTP Range |
| 10 | UFW: открыты только SSH + HTTP + HTTPS |
| 11 | (Опционально) Let's Encrypt сертификат через certbot |

## Идемпотентность

Скрипт безопасно перезапускается. Повторный запуск:
- обновит код через `git pull`
- переустановит зависимости
- пересоберёт фронтенд
- перезапустит сервис

Никаких данных (комнаты в MongoDB, файлы в `uploads/`) не теряется.

## Структура установки на сервере

```
/opt/syncplay/                ← код
├── backend/
│   ├── server.py
│   ├── venv/                 ← Python venv
│   ├── .env                  ← MONGO_URL, DB_NAME
│   └── uploads/              ← MP3 + обложки
└── frontend/
    └── build/                ← статика, отдаётся Nginx

/etc/systemd/system/syncplay.service        ← unit
/etc/nginx/sites-enabled/syncplay           ← конфиг Nginx
/var/log/syncplay.log                       ← stdout
/var/log/syncplay.err.log                   ← stderr
```

## Полезные команды

```bash
# Статус и логи
systemctl status syncplay
journalctl -u syncplay -f                # live-логи
tail -f /var/log/nginx/access.log         # запросы

# Перезапуск
systemctl restart syncplay
systemctl reload nginx

# Обновление кода с GitHub
cd /opt/syncplay && sudo -u syncplay git pull && sudo systemctl restart syncplay

# Очистка загруженных файлов (на случай переполнения диска)
sudo find /opt/syncplay/backend/uploads -type f -mtime +1 -delete
```

## Решение проблем

### Backend не стартует
```bash
journalctl -u syncplay -n 100 --no-pager
```
Чаще всего — ошибка в `.env` или порт занят.

### MongoDB не стартует на старом ядре
MongoDB 7 требует ядро ≥ 4.4. Проверьте `uname -r`. Для старых VPS поставьте MongoDB 6.0 (замените `7.0` на `6.0` в скрипте).

### Не работает WebSocket через HTTPS
Убедитесь, что в Nginx-конфиге есть:
```nginx
proxy_set_header Upgrade $http_upgrade;
proxy_set_header Connection "upgrade";
```
(скрипт это делает автоматически).

### Cloudflare блокирует Range-запросы (если используете CF перед сервером)
**Не используйте Cloudflare** — он недоступен из части РФ и может ломать Range. Подключайтесь к серверу напрямую по IP/домену.

### Не выписывается Let's Encrypt
- Проверьте, что DNS A-запись домена указывает на IP сервера: `dig +short syncplay.ru`
- Порт 80 открыт и доступен извне.
- Запустите вручную: `sudo certbot --nginx -d syncplay.ru`

## Удаление

```bash
sudo systemctl stop syncplay && sudo systemctl disable syncplay
sudo rm /etc/systemd/system/syncplay.service
sudo rm /etc/nginx/sites-enabled/syncplay /etc/nginx/sites-available/syncplay
sudo systemctl reload nginx
sudo rm -rf /opt/syncplay
sudo userdel -r syncplay
# MongoDB и Nginx остаются — удалите вручную, если не нужны другим сервисам
```
