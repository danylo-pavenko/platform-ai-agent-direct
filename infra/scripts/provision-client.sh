#!/usr/bin/env bash
#
# provision-client.sh — Onboard a new client (tenant) onto the platform
#
# Run as root:
#   bash provision-client.sh <INSTANCE_ID> <CLIENT_NAME> <API_DOMAIN> <ADMIN_DOMAIN> <API_PORT> <ADMIN_PORT>
#
# Example:
#   bash provision-client.sh sb StatusBlessed api.status-blessed.com agent.status-blessed.com 3100 3101
#   bash provision-client.sh mb MyBrand api.mybrand.com admin.mybrand.com 3200 3201
#
# What this does:
#   - Creates Linux user agent_{instance_id}
#   - Creates PostgreSQL DB {instance_id}_agent with a dedicated user
#   - Creates /opt/agents/{instance_id}/ and clones the platform repo
#   - Generates .env from template with all provided values
#   - Creates NGINX vhost for API and Admin domains
#   - Obtains TLS certificates via Certbot
#   - Registers tenant in platform_admin DB (if available)
#   - Prints next steps (including: claude auth login)
#
set -euo pipefail

# ── Args ──
INSTANCE_ID="${1:?Usage: $0 <INSTANCE_ID> <CLIENT_NAME> <API_DOMAIN> <ADMIN_DOMAIN> <API_PORT> <ADMIN_PORT>}"
CLIENT_NAME="${2:?Missing CLIENT_NAME}"
API_DOMAIN="${3:?Missing API_DOMAIN}"
ADMIN_DOMAIN="${4:?Missing ADMIN_DOMAIN}"
API_PORT="${5:?Missing API_PORT}"
ADMIN_PORT="${6:?Missing ADMIN_PORT}"

# ── Config ──
INSTANCE_ID_UPPER="${INSTANCE_ID^^}"   # uppercase
LINUX_USER="agent_${INSTANCE_ID}"
APP_DIR="/opt/agents/${INSTANCE_ID}"
PG_DB="${INSTANCE_ID}_agent"
PG_USER="${INSTANCE_ID}_agent"
PLATFORM_REPO="${PLATFORM_REPO:-https://github.com/danylo-pavenko/platform-ai-agent-direct.git}"
CERTBOT_EMAIL="${CERTBOT_EMAIL:-}"

echo "══════════════════════════════════════════════"
echo "  Platform — Provision Client: ${CLIENT_NAME}"
echo "  Instance ID: ${INSTANCE_ID_UPPER}"
echo "  API:   https://${API_DOMAIN}"
echo "  Admin: https://${ADMIN_DOMAIN}"
echo "  Ports: ${API_PORT} / ${ADMIN_PORT}"
echo "  $(date '+%Y-%m-%d %H:%M:%S')"
echo "══════════════════════════════════════════════"

if [[ $EUID -ne 0 ]]; then
  echo "ERROR: Run as root"
  exit 1
fi

# ── Validate port uniqueness ──
for port in "${API_PORT}" "${ADMIN_PORT}"; do
  if ss -tlnp | grep -q ":${port} "; then
    echo "ERROR: Port ${port} is already in use. Choose different ports."
    exit 1
  fi
done

# ── 1. Linux user ──
echo ""
echo "[1/8] Creating Linux user '${LINUX_USER}'..."
if ! id "${LINUX_USER}" &>/dev/null; then
  useradd -m -s /bin/bash "${LINUX_USER}"
  echo "  Created: ${LINUX_USER}"
else
  echo "  Already exists: ${LINUX_USER}"
fi

mkdir -p "${APP_DIR}" "${APP_DIR}/uploads"
chown -R "${LINUX_USER}:${LINUX_USER}" "${APP_DIR}"
chmod 750 "${APP_DIR}"

# ── 2. PostgreSQL ──
echo "[2/8] Creating PostgreSQL database '${PG_DB}'..."
systemctl start postgresql

PG_PASS=$(openssl rand -base64 24 | tr -d '/+=' | head -c 32)

sudo -u postgres psql -tc "SELECT 1 FROM pg_roles WHERE rolname='${PG_USER}'" | grep -q 1 || \
  sudo -u postgres psql -c "CREATE USER ${PG_USER} WITH PASSWORD '${PG_PASS}';"

sudo -u postgres psql -tc "SELECT 1 FROM pg_database WHERE datname='${PG_DB}'" | grep -q 1 || \
  sudo -u postgres psql -c "CREATE DATABASE ${PG_DB} OWNER ${PG_USER};"

DB_URL="postgresql://${PG_USER}:${PG_PASS}@localhost:5432/${PG_DB}"
echo "  Database: ${PG_DB}, User: ${PG_USER}"

# ── 3. Clone platform repo ──
echo "[3/8] Cloning platform repo to ${APP_DIR}..."
if [ ! -d "${APP_DIR}/.git" ]; then
  sudo -u "${LINUX_USER}" git clone "${PLATFORM_REPO}" "${APP_DIR}"
  echo "  Cloned from ${PLATFORM_REPO}"
else
  echo "  Repo already exists — pulling latest..."
  sudo -u "${LINUX_USER}" git -C "${APP_DIR}" pull --ff-only
fi

# ── 4. Generate .env ──
echo "[4/8] Generating .env for ${INSTANCE_ID_UPPER}..."
ENV_FILE="${APP_DIR}/.env"
JWT_SECRET=$(openssl rand -hex 32)
ADMIN_PASS="${INSTANCE_ID_UPPER}-change-me-$(date +%Y)!"
TG_ADMIN_PASS="${INSTANCE_ID_UPPER}-tg-$(openssl rand -hex 4)!"

if [ ! -f "${ENV_FILE}" ]; then
  cat > "${ENV_FILE}" <<EOF
# ── Identity ──
INSTANCE_ID=${INSTANCE_ID}
INSTANCE_NAME=${CLIENT_NAME}
BRAND_NAME=${CLIENT_NAME}

# ── Domains ──
ADMIN_DOMAIN=${ADMIN_DOMAIN}
API_DOMAIN=${API_DOMAIN}
API_PORT=${API_PORT}
ADMIN_PORT=${ADMIN_PORT}

# ── Default admin credentials (change after first login!) ──
DEFAULT_ADMIN_USERNAME=admin
DEFAULT_ADMIN_PASSWORD=${ADMIN_PASS}

# ── Database ──
DATABASE_URL=${DB_URL}

# ── CRM ──
CRM_PROVIDER=none
KEYCRM_API_KEY=
KEYCRM_SYNC_INTERVAL_MIN=30

# ── Meta / Instagram ──
META_APP_ID=
META_APP_SECRET=
IG_PAGE_ACCESS_TOKEN=
IG_PAGE_ID=
IG_WEBHOOK_VERIFY_TOKEN=${INSTANCE_ID}-verify-$(date +%Y)

# ── Telegram ──
TELEGRAM_BOT_TOKEN=
TELEGRAM_MANAGER_GROUP_ID=
TELEGRAM_ADMIN_PASSWORD=${TG_ADMIN_PASS}

# ── Claude ──
CLAUDE_MAX_CONCURRENCY=2
CLAUDE_TIMEOUT_MS=30000
CLAUDE_MODEL=sonnet

# ── Auth ──
JWT_SECRET=${JWT_SECRET}
JWT_EXPIRES_IN=7d

# ── File storage ──
UPLOADS_DIR=${APP_DIR}/uploads

# ── Logging ──
LOG_LEVEL=info
EOF
  chown "${LINUX_USER}:${LINUX_USER}" "${ENV_FILE}"
  chmod 600 "${ENV_FILE}"
  echo "  Created ${ENV_FILE}"
else
  echo "  .env already exists — skipping (manual update required)"
fi

# ── 5. NGINX vhost ──
echo "[5/8] Creating NGINX vhost for ${API_DOMAIN} + ${ADMIN_DOMAIN}..."
NGINX_CONF="/etc/nginx/sites-available/${INSTANCE_ID}-agent.conf"

# Temporary HTTP config for certbot
cat > "${NGINX_CONF}" <<NGINX
server {
    listen 80;
    listen [::]:80;
    server_name ${API_DOMAIN} ${ADMIN_DOMAIN};

    location /.well-known/acme-challenge/ {
        root /var/www/certbot;
    }

    location / {
        return 200 'provisioning...';
        add_header Content-Type text/plain;
    }
}
NGINX

ln -sf "${NGINX_CONF}" /etc/nginx/sites-enabled/
mkdir -p /var/www/certbot
nginx -t && systemctl reload nginx

# ── 6. TLS certificates ──
echo "[6/8] Obtaining TLS certificates..."
if [ -z "${CERTBOT_EMAIL}" ]; then
  read -rp "  Enter email for Let's Encrypt: " CERTBOT_EMAIL
fi

for domain in "${API_DOMAIN}" "${ADMIN_DOMAIN}"; do
  if [ ! -d "/etc/letsencrypt/live/${domain}" ]; then
    certbot certonly --nginx \
      --non-interactive \
      --agree-tos \
      --email "${CERTBOT_EMAIL}" \
      -d "${domain}"
    echo "  Certificate: ${domain}"
  else
    echo "  Certificate already exists: ${domain}"
  fi
done

# Install full HTTPS NGINX config
cat > "${NGINX_CONF}" <<NGINX
# ${CLIENT_NAME} (${INSTANCE_ID_UPPER}) — Admin SPA
server {
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    server_name ${ADMIN_DOMAIN};

    ssl_certificate     /etc/letsencrypt/live/${ADMIN_DOMAIN}/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/${ADMIN_DOMAIN}/privkey.pem;
    ssl_protocols       TLSv1.2 TLSv1.3;

    location / {
        proxy_pass http://127.0.0.1:${ADMIN_PORT};
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
    }
}

# ${CLIENT_NAME} (${INSTANCE_ID_UPPER}) — Backend API + IG webhook
server {
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    server_name ${API_DOMAIN};

    ssl_certificate     /etc/letsencrypt/live/${API_DOMAIN}/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/${API_DOMAIN}/privkey.pem;
    ssl_protocols       TLSv1.2 TLSv1.3;

    client_max_body_size 10m;

    location / {
        proxy_pass http://127.0.0.1:${API_PORT};
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }
}

# HTTP → HTTPS redirect
server {
    listen 80;
    listen [::]:80;
    server_name ${API_DOMAIN} ${ADMIN_DOMAIN};
    return 301 https://\$host\$request_uri;
}
NGINX

nginx -t && systemctl reload nginx

# ── 7. Register tenant in super-admin DB ──
echo "[7/8] Registering tenant in platform_admin DB..."
SA_DB_EXISTS=$(sudo -u postgres psql -tc "SELECT 1 FROM pg_database WHERE datname='platform_admin'" | tr -d ' \n')
if [ "${SA_DB_EXISTS}" = "1" ]; then
  sudo -u postgres psql -d platform_admin -c "
    INSERT INTO tenants (
      instance_id, name, api_domain, admin_domain,
      api_port, admin_port, linux_user, app_dir, status
    ) VALUES (
      '${INSTANCE_ID}', '${CLIENT_NAME}', '${API_DOMAIN}', '${ADMIN_DOMAIN}',
      ${API_PORT}, ${ADMIN_PORT}, '${LINUX_USER}', '${APP_DIR}', 'provisioned'
    ) ON CONFLICT (instance_id) DO UPDATE SET
      name = EXCLUDED.name,
      api_domain = EXCLUDED.api_domain,
      admin_domain = EXCLUDED.admin_domain,
      status = 'provisioned',
      updated_at = NOW();
  " 2>/dev/null && echo "  Registered in super-admin DB" || echo "  (tenants table not ready yet — register manually)"
else
  echo "  platform_admin DB not found — skipping registration"
fi

# ── 8. Sudoers for deploy ──
echo "[8/8] Configuring deploy permissions..."
SUDOERS_FILE="/etc/sudoers.d/${LINUX_USER}-deploy"
cat > "${SUDOERS_FILE}" <<SUDOERS
# Allow ${LINUX_USER} to reload nginx and restart its own PM2 processes
${LINUX_USER} ALL=(ALL) NOPASSWD: /bin/systemctl reload nginx
SUDOERS
chmod 440 "${SUDOERS_FILE}"

# ── Summary ──
echo ""
echo "══════════════════════════════════════════════"
echo "  Client provisioned: ${CLIENT_NAME} (${INSTANCE_ID_UPPER})"
echo "══════════════════════════════════════════════"
echo ""
echo "  Linux user: ${LINUX_USER}"
echo "  App dir:    ${APP_DIR}"
echo "  API URL:    https://${API_DOMAIN}"
echo "  Admin URL:  https://${ADMIN_DOMAIN}"
echo ""
echo "  ┌──────────────────────────────────────────────────────────┐"
echo "  │ DATABASE_URL=${DB_URL}"
echo "  │ Admin password: ${ADMIN_PASS}"
echo "  │ TG admin pass:  ${TG_ADMIN_PASS}"
echo "  └──────────────────────────────────────────────────────────┘"
echo ""
echo "  REQUIRED MANUAL STEPS:"
echo ""
echo "  1. Fill in API credentials in .env:"
echo "     su - ${LINUX_USER}"
echo "     nano ${APP_DIR}/.env"
echo "     # Set: META_APP_ID, META_APP_SECRET, IG_PAGE_ACCESS_TOKEN, IG_PAGE_ID"
echo "     # Set: TELEGRAM_BOT_TOKEN, TELEGRAM_MANAGER_GROUP_ID"
echo "     # Set: CRM_PROVIDER + KEYCRM_API_KEY (if needed)"
echo ""
echo "  2. Authenticate Claude Code (INTERACTIVE — opens browser):"
echo "     su - ${LINUX_USER}"
echo "     claude auth login"
echo ""
echo "  3. Deploy the app:"
echo "     su - ${LINUX_USER}"
echo "     bash ${APP_DIR}/infra/scripts/deploy-client.sh"
echo ""
echo "  4. Subscribe Instagram webhook:"
echo "     URL: https://${API_DOMAIN}/webhooks/instagram"
echo "     Verify token: see IG_WEBHOOK_VERIFY_TOKEN in .env"
echo ""
