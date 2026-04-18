#!/usr/bin/env bash
#
# provision-super-admin.sh — Set up the Super Admin dashboard app
#
# Run as root after provision-server.sh:
#   SUPER_ADMIN_DOMAIN=admin.yourplatform.com \
#   CERTBOT_EMAIL=you@example.com \
#   SUPER_ADMIN_REPO=https://github.com/yourorg/platform-super-admin.git \
#   bash provision-super-admin.sh
#
# What this does:
#   - Creates Linux user 'platform_admin'
#   - Creates PostgreSQL DB 'platform_admin' (stores tenant registry)
#   - Clones super-admin app to /opt/platform-admin
#   - Generates NGINX vhost + TLS cert for SUPER_ADMIN_DOMAIN
#   - Starts PM2 processes: SA-api (port 4000), SA-app (port 4001)
#
set -euo pipefail

# ── Required env ──
SUPER_ADMIN_DOMAIN="${SUPER_ADMIN_DOMAIN:?Set SUPER_ADMIN_DOMAIN (e.g. admin.yourplatform.com)}"
CERTBOT_EMAIL="${CERTBOT_EMAIL:?Set CERTBOT_EMAIL}"
SUPER_ADMIN_REPO="${SUPER_ADMIN_REPO:-}"   # optional — skip clone if empty

# ── Config ──
LINUX_USER="platform_admin"
APP_DIR="/opt/platform-admin"
PG_DB="platform_admin"
PG_USER="platform_admin"
SA_API_PORT=4000
SA_APP_PORT=4001

echo "══════════════════════════════════════════════"
echo "  Platform Super Admin — Provision"
echo "  $(date '+%Y-%m-%d %H:%M:%S')"
echo "══════════════════════════════════════════════"

if [[ $EUID -ne 0 ]]; then
  echo "ERROR: Run as root"
  exit 1
fi

# ── 1. Linux user ──
echo "[1/7] Creating Linux user '${LINUX_USER}'..."
if ! id "${LINUX_USER}" &>/dev/null; then
  useradd -m -s /bin/bash "${LINUX_USER}"
  echo "  Created user ${LINUX_USER}"
else
  echo "  User ${LINUX_USER} already exists"
fi

mkdir -p "${APP_DIR}"
chown -R "${LINUX_USER}:${LINUX_USER}" "${APP_DIR}"

# ── 2. PostgreSQL ──
echo "[2/7] Creating PostgreSQL database '${PG_DB}'..."
systemctl enable postgresql
systemctl start postgresql

PG_PASS=$(openssl rand -base64 24 | tr -d '/+=' | head -c 32)

sudo -u postgres psql -tc "SELECT 1 FROM pg_roles WHERE rolname='${PG_USER}'" | grep -q 1 || \
  sudo -u postgres psql -c "CREATE USER ${PG_USER} WITH PASSWORD '${PG_PASS}';"

sudo -u postgres psql -tc "SELECT 1 FROM pg_database WHERE datname='${PG_DB}'" | grep -q 1 || \
  sudo -u postgres psql -c "CREATE DATABASE ${PG_DB} OWNER ${PG_USER};"

SUPER_ADMIN_DB_URL="postgresql://${PG_USER}:${PG_PASS}@localhost:5432/${PG_DB}"
echo ""
echo "  ┌────────────────────────────────────────────────────────────┐"
echo "  │ DATABASE_URL=${SUPER_ADMIN_DB_URL}"
echo "  │ Save this — needed for super-admin .env                    │"
echo "  └────────────────────────────────────────────────────────────┘"
echo ""

# ── 3. Clone super-admin repo ──
echo "[3/7] Setting up super-admin app..."
if [ -n "${SUPER_ADMIN_REPO}" ]; then
  if [ ! -d "${APP_DIR}/.git" ]; then
    sudo -u "${LINUX_USER}" git clone "${SUPER_ADMIN_REPO}" "${APP_DIR}"
    echo "  Cloned from ${SUPER_ADMIN_REPO}"
  else
    sudo -u "${LINUX_USER}" git -C "${APP_DIR}" pull --ff-only
    echo "  Updated from remote"
  fi
else
  echo "  SUPER_ADMIN_REPO not set — skipping clone."
  echo "  Manually deploy the super-admin app to ${APP_DIR}"
fi

# ── 4. Create .env for super admin ──
echo "[4/7] Creating super-admin .env..."
ENV_FILE="${APP_DIR}/.env"
if [ ! -f "${ENV_FILE}" ]; then
  JWT_SECRET=$(openssl rand -hex 32)
  cat > "${ENV_FILE}" <<EOF
# Super Admin App Configuration
NODE_ENV=production

# Identity
INSTANCE_ID=sa
INSTANCE_NAME=PlatformSuperAdmin

# Ports
SA_API_PORT=${SA_API_PORT}
SA_APP_PORT=${SA_APP_PORT}
SUPER_ADMIN_DOMAIN=${SUPER_ADMIN_DOMAIN}

# Database (tenant registry)
DATABASE_URL=${SUPER_ADMIN_DB_URL}

# Auth
JWT_SECRET=${JWT_SECRET}
JWT_EXPIRES_IN=7d

# Default super-admin credentials (change after first login!)
SA_ADMIN_USERNAME=superadmin
SA_ADMIN_PASSWORD=$(openssl rand -hex 8)

# Logging
LOG_LEVEL=info
EOF
  chown "${LINUX_USER}:${LINUX_USER}" "${ENV_FILE}"
  chmod 600 "${ENV_FILE}"
  echo "  Created ${ENV_FILE}"
  echo ""
  echo "  ┌────────────────────────────────────────────────────────────┐"
  echo "  │ Default super-admin password saved in ${ENV_FILE}"
  echo "  │ Run: sudo cat ${ENV_FILE} | grep SA_ADMIN_PASSWORD          │"
  echo "  └────────────────────────────────────────────────────────────┘"
  echo ""
else
  echo "  .env already exists — skipping"
fi

# ── 5. NGINX vhost ──
echo "[5/7] Creating NGINX vhost for ${SUPER_ADMIN_DOMAIN}..."
NGINX_CONF="/etc/nginx/sites-available/platform-super-admin.conf"

cat > "${NGINX_CONF}" <<NGINX
# Super Admin — HTTP (temporary, certbot will add SSL)
server {
    listen 80;
    listen [::]:80;
    server_name ${SUPER_ADMIN_DOMAIN};

    location /.well-known/acme-challenge/ {
        root /var/www/certbot;
    }

    location / {
        return 301 https://\$host\$request_uri;
    }
}
NGINX

ln -sf "${NGINX_CONF}" /etc/nginx/sites-enabled/
mkdir -p /var/www/certbot
nginx -t && systemctl reload nginx

# ── 6. TLS certificate ──
echo "[6/7] Obtaining TLS certificate for ${SUPER_ADMIN_DOMAIN}..."
if [ ! -d "/etc/letsencrypt/live/${SUPER_ADMIN_DOMAIN}" ]; then
  certbot certonly --nginx \
    --non-interactive \
    --agree-tos \
    --email "${CERTBOT_EMAIL}" \
    -d "${SUPER_ADMIN_DOMAIN}"
  echo "  Certificate obtained"
else
  echo "  Certificate already exists"
fi

# Now install the full HTTPS nginx config
cat > "${NGINX_CONF}" <<NGINX
# Super Admin Dashboard
server {
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    server_name ${SUPER_ADMIN_DOMAIN};

    ssl_certificate     /etc/letsencrypt/live/${SUPER_ADMIN_DOMAIN}/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/${SUPER_ADMIN_DOMAIN}/privkey.pem;
    ssl_protocols       TLSv1.2 TLSv1.3;

    # Frontend Vue SPA
    location / {
        proxy_pass http://127.0.0.1:${SA_APP_PORT};
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
    }

    # Backend API
    location /api/ {
        proxy_pass http://127.0.0.1:${SA_API_PORT}/;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }
}

server {
    listen 80;
    listen [::]:80;
    server_name ${SUPER_ADMIN_DOMAIN};
    return 301 https://\$host\$request_uri;
}
NGINX

nginx -t && systemctl reload nginx

# ── 7. PM2 startup ──
echo "[7/7] Configuring PM2 startup..."
# Register PM2 to start on boot (run once globally)
pm2 startup systemd -u root --hp /root 2>/dev/null || true

echo ""
echo "══════════════════════════════════════════════"
echo "  Super Admin provision complete!"
echo "══════════════════════════════════════════════"
echo ""
echo "  App dir:  ${APP_DIR}"
echo "  URL:      https://${SUPER_ADMIN_DOMAIN}"
echo "  DB:       ${SUPER_ADMIN_DB_URL}"
echo ""
echo "  Next: deploy the super-admin app:"
echo "    su - ${LINUX_USER}"
echo "    cd ${APP_DIR}"
echo "    npm ci"
echo "    npm run build"
echo "    pm2 start ecosystem.config.cjs"
echo "    pm2 save"
echo ""
echo "  Then provision your first client:"
echo "    bash provision-client.sh sb StatusBlessed api.status-blessed.com agent.status-blessed.com 3100 3101"
echo ""
