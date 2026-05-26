#!/usr/bin/env bash
# ============================================================================
# SyncPlay — автоматический деплой на Ubuntu 22.04 LTS VPS
#
# Использование:
#   sudo bash deploy.sh
#
# Скрипт интерактивный — спросит:
#   - URL git-репозитория (или путь к локальной копии)
#   - Доменное имя (опционально, для HTTPS)
#   - E-mail для Let's Encrypt (опционально)
#
# Что делает:
#   1. Ставит Python 3.11, Node.js 20, Yarn, MongoDB 7, Nginx, Certbot.
#   2. Клонирует/копирует проект в /opt/syncplay.
#   3. Создаёт .env для backend и frontend.
#   4. Устанавливает Python и Node-зависимости, билдит фронтенд.
#   5. Создаёт systemd-сервис `syncplay` для бэкенда.
#   6. Настраивает Nginx с поддержкой WebSocket + Range requests.
#   7. (Опционально) выписывает Let's Encrypt сертификат.
#
# Скрипт идемпотентный — можно запускать повторно для обновлений.
# ============================================================================

set -euo pipefail

# --------- Цвета для вывода ---------
RED='\033[0;31m'
GRN='\033[0;32m'
YLW='\033[1;33m'
CYN='\033[0;36m'
NC='\033[0m'

info()  { echo -e "${CYN}[i]${NC} $*"; }
ok()    { echo -e "${GRN}[✓]${NC} $*"; }
warn()  { echo -e "${YLW}[!]${NC} $*"; }
fail()  { echo -e "${RED}[✗]${NC} $*" >&2; exit 1; }

# --------- Проверка прав ---------
[[ $EUID -eq 0 ]] || fail "Запустите от root: sudo bash deploy.sh"

# --------- Проверка ОС ---------
. /etc/os-release || fail "Не удаётся определить ОС"
if [[ "$ID" != "ubuntu" ]] && [[ "$ID" != "debian" ]]; then
    warn "Скрипт тестировался на Ubuntu 22.04. Текущая ОС: $PRETTY_NAME"
    read -rp "Продолжить? (y/N): " ans
    [[ "${ans,,}" == "y" ]] || exit 1
fi

# ============================================================================
# Шаг 0: Сбор параметров
# ============================================================================
echo
echo "========================================================"
echo "  SyncPlay — автоматический деплой"
echo "========================================================"
echo

# Источник кода
echo "Откуда брать код проекта?"
echo "  1) Git-репозиторий (рекомендуется)"
echo "  2) Локальная папка"
read -rp "Выбор (1/2): " SRC_TYPE
case "$SRC_TYPE" in
    1)
        read -rp "URL git-репозитория (https://github.com/.../syncplay.git): " GIT_URL
        [[ -n "$GIT_URL" ]] || fail "URL обязателен"
        ;;
    2)
        read -rp "Полный путь к папке с проектом: " LOCAL_PATH
        [[ -d "$LOCAL_PATH" ]] || fail "Папка $LOCAL_PATH не найдена"
        ;;
    *) fail "Неверный выбор" ;;
esac

# Домен и SSL
read -rp "Доменное имя (например, syncplay.ru) [пусто = только по IP]: " DOMAIN
SSL_ENABLED=false
if [[ -n "$DOMAIN" ]]; then
    read -rp "E-mail для Let's Encrypt [пусто = пропустить SSL]: " LE_EMAIL
    [[ -n "$LE_EMAIL" ]] && SSL_ENABLED=true
fi

# Параметры деплоя
APP_DIR="/opt/syncplay"
APP_USER="syncplay"
BACKEND_PORT=8001

echo
info "Параметры:"
info "  Папка установки: $APP_DIR"
info "  Системный пользователь: $APP_USER"
info "  Backend порт: $BACKEND_PORT"
[[ -n "$DOMAIN" ]] && info "  Домен: $DOMAIN"
$SSL_ENABLED && info "  SSL: Let's Encrypt ($LE_EMAIL)"
echo
read -rp "Начать установку? (y/N): " confirm
[[ "${confirm,,}" == "y" ]] || exit 0

# ============================================================================
# Шаг 1: Системные пакеты
# ============================================================================
info "Обновление APT и установка базовых пакетов..."
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -yqq \
    curl wget gnupg ca-certificates lsb-release \
    git build-essential ufw \
    python3.11 python3.11-venv python3.11-dev \
    nginx >/dev/null

ok "Базовые пакеты установлены"

# ============================================================================
# Шаг 2: Node.js 20 + Yarn
# ============================================================================
if ! command -v node >/dev/null 2>&1 || [[ "$(node -v | grep -oE '[0-9]+' | head -1)" -lt 18 ]]; then
    info "Установка Node.js 20..."
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash - >/dev/null
    apt-get install -yqq nodejs >/dev/null
fi

if ! command -v yarn >/dev/null 2>&1; then
    info "Установка Yarn..."
    npm install -g yarn >/dev/null 2>&1
fi
ok "Node.js $(node -v), Yarn $(yarn -v)"

# ============================================================================
# Шаг 3: MongoDB 7
# ============================================================================
if ! systemctl list-unit-files | grep -q mongod.service; then
    info "Установка MongoDB 7..."
    curl -fsSL https://pgp.mongodb.com/server-7.0.asc | \
        gpg -o /usr/share/keyrings/mongodb-7.0.gpg --dearmor --yes
    UBUNTU_CODENAME="$(lsb_release -cs)"
    # MongoDB официально поддерживает jammy (22.04). Для других — используем jammy.
    case "$UBUNTU_CODENAME" in
        jammy|focal|noble) MONGO_REPO="$UBUNTU_CODENAME" ;;
        *) MONGO_REPO="jammy" ;;
    esac
    echo "deb [signed-by=/usr/share/keyrings/mongodb-7.0.gpg] https://repo.mongodb.org/apt/ubuntu $MONGO_REPO/mongodb-org/7.0 multiverse" \
        > /etc/apt/sources.list.d/mongodb-org-7.0.list
    apt-get update -qq
    apt-get install -yqq mongodb-org >/dev/null
fi
systemctl enable --now mongod
sleep 2
systemctl is-active --quiet mongod || fail "MongoDB не запустилась"
ok "MongoDB 7 работает"

# ============================================================================
# Шаг 4: Системный пользователь
# ============================================================================
if ! id -u "$APP_USER" >/dev/null 2>&1; then
    useradd -r -m -d "$APP_DIR" -s /bin/bash "$APP_USER"
    ok "Создан пользователь $APP_USER"
fi

# ============================================================================
# Шаг 5: Получаем код
# ============================================================================
info "Получение кода..."
if [[ "$SRC_TYPE" == "1" ]]; then
    if [[ -d "$APP_DIR/.git" ]]; then
        info "Репозиторий уже есть — обновляем (git pull)..."
        sudo -u "$APP_USER" git -C "$APP_DIR" pull --rebase
    else
        rm -rf "$APP_DIR"
        sudo -u "$APP_USER" git clone "$GIT_URL" "$APP_DIR"
    fi
else
    rm -rf "$APP_DIR"
    mkdir -p "$APP_DIR"
    cp -r "$LOCAL_PATH"/. "$APP_DIR"/
    chown -R "$APP_USER:$APP_USER" "$APP_DIR"
fi

[[ -f "$APP_DIR/backend/server.py" ]] || fail "В $APP_DIR нет backend/server.py"
[[ -f "$APP_DIR/frontend/package.json" ]] || fail "В $APP_DIR нет frontend/package.json"
ok "Код развёрнут в $APP_DIR"

# ============================================================================
# Шаг 6: Backend — venv + зависимости + .env
# ============================================================================
info "Установка Python-зависимостей..."
sudo -u "$APP_USER" python3.11 -m venv "$APP_DIR/backend/venv"
sudo -u "$APP_USER" "$APP_DIR/backend/venv/bin/pip" install -q --upgrade pip
sudo -u "$APP_USER" "$APP_DIR/backend/venv/bin/pip" install -q -r "$APP_DIR/backend/requirements.txt"

# .env для backend
BACKEND_ENV="$APP_DIR/backend/.env"
if [[ ! -f "$BACKEND_ENV" ]]; then
    cat > "$BACKEND_ENV" <<EOF
MONGO_URL=mongodb://localhost:27017
DB_NAME=syncplay
CORS_ORIGINS=*
EOF
    chown "$APP_USER:$APP_USER" "$BACKEND_ENV"
    chmod 600 "$BACKEND_ENV"
fi

# Папка для загрузок
mkdir -p "$APP_DIR/backend/uploads"
chown -R "$APP_USER:$APP_USER" "$APP_DIR/backend/uploads"
ok "Backend готов"

# ============================================================================
# Шаг 7: Frontend — yarn install + build
# ============================================================================
info "Установка фронтенд-зависимостей и сборка..."
FRONTEND_ENV="$APP_DIR/frontend/.env"
if [[ -n "$DOMAIN" ]]; then
    PROTOCOL="http"
    $SSL_ENABLED && PROTOCOL="https"
    BACKEND_URL="$PROTOCOL://$DOMAIN"
else
    # По IP — нужен внешний IP сервера
    PUB_IP="$(curl -s --max-time 5 https://api.ipify.org || echo "")"
    BACKEND_URL="http://${PUB_IP:-localhost}"
fi

cat > "$FRONTEND_ENV" <<EOF
REACT_APP_BACKEND_URL=$BACKEND_URL
WDS_SOCKET_PORT=0
EOF
chown "$APP_USER:$APP_USER" "$FRONTEND_ENV"

sudo -u "$APP_USER" bash -c "cd '$APP_DIR/frontend' && yarn install --frozen-lockfile 2>&1" | tail -5
sudo -u "$APP_USER" bash -c "cd '$APP_DIR/frontend' && yarn build 2>&1" | tail -5
ok "Frontend собран → $APP_DIR/frontend/build"

# ============================================================================
# Шаг 8: systemd-сервис
# ============================================================================
info "Настройка systemd..."
cat > /etc/systemd/system/syncplay.service <<EOF
[Unit]
Description=SyncPlay backend (FastAPI + WebSocket)
After=network.target mongod.service
Wants=mongod.service

[Service]
Type=simple
User=$APP_USER
Group=$APP_USER
WorkingDirectory=$APP_DIR/backend
EnvironmentFile=$APP_DIR/backend/.env
ExecStart=$APP_DIR/backend/venv/bin/uvicorn server:app --host 127.0.0.1 --port $BACKEND_PORT --workers 1
Restart=always
RestartSec=5
StandardOutput=append:/var/log/syncplay.log
StandardError=append:/var/log/syncplay.err.log

# Безопасность
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
ReadWritePaths=$APP_DIR/backend/uploads /var/log

[Install]
WantedBy=multi-user.target
EOF

touch /var/log/syncplay.log /var/log/syncplay.err.log
chown "$APP_USER:$APP_USER" /var/log/syncplay.log /var/log/syncplay.err.log

systemctl daemon-reload
systemctl enable syncplay
systemctl restart syncplay
sleep 3
systemctl is-active --quiet syncplay || {
    journalctl -u syncplay -n 50 --no-pager
    fail "Сервис syncplay не запустился — см. логи выше"
}
ok "Сервис syncplay активен (порт $BACKEND_PORT)"

# ============================================================================
# Шаг 9: Nginx
# ============================================================================
info "Настройка Nginx..."
SERVER_NAME="${DOMAIN:-_}"

cat > /etc/nginx/sites-available/syncplay <<EOF
# SyncPlay — Nginx-конфиг с поддержкой WebSocket и HTTP Range
server {
    listen 80;
    listen [::]:80;
    server_name $SERVER_NAME;

    # Загрузка MP3 до 20 МБ + небольшой запас
    client_max_body_size 25M;
    client_body_buffer_size 128k;

    # Frontend (статика React build)
    root $APP_DIR/frontend/build;
    index index.html;

    # Кеш статики
    location /static/ {
        expires 1y;
        add_header Cache-Control "public, immutable";
    }

    # SPA — все маршруты возвращают index.html
    location / {
        try_files \$uri /index.html;
    }

    # Backend API + WebSocket
    location /api/ {
        proxy_pass http://127.0.0.1:$BACKEND_PORT;
        proxy_http_version 1.1;

        # Заголовки для FastAPI
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;

        # КРИТИЧНО: WebSocket upgrade
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";

        # WebSocket должен держаться долго
        proxy_read_timeout 86400s;
        proxy_send_timeout 86400s;

        # Передаём Range-заголовки для перемотки аудио
        proxy_set_header Range \$http_range;
        proxy_set_header If-Range \$http_if_range;
        proxy_no_cache 1;
        proxy_cache_bypass 1;

        # Буферизация выключена — для стриминга аудио важнее latency
        proxy_buffering off;
    }
}
EOF

# Подключаем
ln -sf /etc/nginx/sites-available/syncplay /etc/nginx/sites-enabled/syncplay
rm -f /etc/nginx/sites-enabled/default

nginx -t >/dev/null 2>&1 || {
    nginx -t
    fail "Ошибка в Nginx-конфиге"
}
systemctl reload nginx
ok "Nginx настроен"

# ============================================================================
# Шаг 10: Firewall (UFW)
# ============================================================================
info "Настройка фаервола (UFW)..."
ufw allow OpenSSH >/dev/null 2>&1 || true
ufw allow 'Nginx Full' >/dev/null 2>&1 || true
ufw --force enable >/dev/null 2>&1 || true
ok "UFW: разрешены SSH, HTTP, HTTPS"

# ============================================================================
# Шаг 11: SSL (опционально)
# ============================================================================
if $SSL_ENABLED; then
    info "Установка Let's Encrypt сертификата..."
    apt-get install -yqq certbot python3-certbot-nginx >/dev/null
    certbot --nginx \
        --non-interactive \
        --agree-tos \
        --email "$LE_EMAIL" \
        -d "$DOMAIN" || warn "Certbot не смог выписать сертификат — проверьте DNS"

    # Auto-renew
    systemctl enable certbot.timer >/dev/null 2>&1 || true

    # Обновляем .env фронта на https и пересобираем
    sed -i "s|REACT_APP_BACKEND_URL=.*|REACT_APP_BACKEND_URL=https://$DOMAIN|" "$FRONTEND_ENV"
    sudo -u "$APP_USER" bash -c "cd '$APP_DIR/frontend' && yarn build 2>&1" | tail -3
    systemctl reload nginx
    ok "HTTPS активен"
fi

# ============================================================================
# Готово!
# ============================================================================
echo
echo "========================================================"
echo -e "  ${GRN}✓ Деплой завершён успешно!${NC}"
echo "========================================================"
echo
PROTOCOL="http"
$SSL_ENABLED && PROTOCOL="https"
URL="$PROTOCOL://${DOMAIN:-${PUB_IP:-localhost}}"
echo "  Приложение:  $URL"
echo
echo "  Полезные команды:"
echo "    Логи backend:  journalctl -u syncplay -f"
echo "    Логи Nginx:    tail -f /var/log/nginx/access.log"
echo "    Рестарт:       systemctl restart syncplay"
echo "    Обновить код:  cd $APP_DIR && sudo -u $APP_USER git pull && bash $0"
echo
$SSL_ENABLED || warn "Для работы по HTTPS повторите запуск с указанием домена и e-mail"
echo
