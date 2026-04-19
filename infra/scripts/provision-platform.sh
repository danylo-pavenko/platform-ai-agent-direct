#!/usr/bin/env bash
#
# provision-platform.sh — Set up landing + super admin for direct-ai-agents.com
#
# Run as root on Ubuntu 24.04:
#   bash provision-platform.sh
#
# What this does:
#   1. Installs system packages (Node 20, PM2, Nginx, Certbot, PostgreSQL, UFW)
#   2. Creates Linux user 'agentsadmin' (if not exists)
#   3. Clones platform repo to /home/agentsadmin/platform-ai-agent-direct
#   4. Creates PostgreSQL DB 'platform_admin' (super-admin tenant registry)
#   5. Configures NGINX for:
#        direct-ai-agents.com + www  → static landing page
#        admin.direct-ai-agents.com  → super admin app (ports 4000/4001)
#   6. Obtains TLS certificates via Certbot
#   7. Generates .env for super admin
#   8. Prints manual next steps (npm install, PM2 start, claude auth)
#
# Prerequisites:
#   - DNS A-records already pointing to this server's IP:
#       direct-ai-agents.com     → <server IP>
#       www.direct-ai-agents.com → <server IP>
#       admin.direct-ai-agents.com → <server IP>
#   - Set CERTBOT_EMAIL before running
#
set -euo pipefail

# ── Config ─────────────────────────────────────────────────────────
CERTBOT_EMAIL="${CERTBOT_EMAIL:-}"
PLATFORM_REPO="${PLATFORM_REPO:-https://github.com/danylo-pavenko/platform-ai-agent-direct.git}"
LINUX_USER="agentsadmin"
APP_DIR="/home/${LINUX_USER}/platform-ai-agent-direct"
PG_DB="platform_admin"
PG_USER="platform_admin"
LANDING_DOMAIN="direct-ai-agents.com"
ADMIN_DOMAIN="admin.direct-ai-agents.com"
SA_API_PORT=4000
SA_APP_PORT=4001
NODE_VERSION="20"
# ───────────────────────────────────────────────────────────────────

echo ""
echo "╔══════════════════════════════════════════════════════╗"
echo "║     Direct AI Agents — Platform Provision            ║"
echo "║     $(date '+%Y-%m-%d %H:%M:%S')                        ║"
echo "╚══════════════════════════════════════════════════════╝"
echo ""

if [[ $EUID -ne 0 ]]; then
  echo "ERROR: Run as root  →  sudo bash provision-platform.sh"
  exit 1
fi

# Ask for email if not set
if [ -z "${CERTBOT_EMAIL}" ]; then
  read -rp "Enter email for Let's Encrypt certificates: " CERTBOT_EMAIL
fi

# ── 1. System packages ─────────────────────────────────────────────
echo "[1/9] Installing system packages..."
apt-get update -qq
apt-get install -y -qq \
  curl git build-essential nginx certbot python3-certbot-nginx \
  postgresql postgresql-contrib ufw jq
echo "  Done."

# ── 2. Node.js 20 ─────────────────────────────────────────────────
echo "[2/9] Installing Node.js ${NODE_VERSION}..."
if ! command -v node &>/dev/null || [[ "$(node -v)" != v${NODE_VERSION}* ]]; then
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_VERSION}.x" | bash - >/dev/null 2>&1
  apt-get install -y -qq nodejs
fi
echo "  Node: $(node -v)  npm: $(npm -v)"

# ── 3. PM2 ────────────────────────────────────────────────────────
echo "[3/9] Installing PM2..."
npm install -g pm2 --silent
pm2 startup systemd -u root --hp /root >/dev/null 2>&1 || true
echo "  PM2: $(pm2 -v)"

# ── 4. Linux user ─────────────────────────────────────────────────
echo "[4/9] Setting up user '${LINUX_USER}'..."
if ! id "${LINUX_USER}" &>/dev/null; then
  useradd -m -s /bin/bash "${LINUX_USER}"
  echo "  Created user: ${LINUX_USER}"
else
  echo "  User already exists: ${LINUX_USER}"
fi
mkdir -p "${APP_DIR}"
chown -R "${LINUX_USER}:${LINUX_USER}" "/home/${LINUX_USER}"

# ── 5. Clone repo ──────────────────────────────────────────────────
echo "[5/9] Cloning platform repo..."
if [ ! -d "${APP_DIR}/.git" ]; then
  sudo -u "${LINUX_USER}" git clone "${PLATFORM_REPO}" "${APP_DIR}"
  echo "  Cloned to ${APP_DIR}"
else
  sudo -u "${LINUX_USER}" git -C "${APP_DIR}" pull --ff-only
  echo "  Repo already exists — pulled latest"
fi

# ── 6. PostgreSQL ──────────────────────────────────────────────────
echo "[6/9] Setting up PostgreSQL..."
systemctl enable postgresql --quiet
systemctl start postgresql

PG_PASS=$(openssl rand -base64 24 | tr -d '/+=' | head -c 32)

sudo -u postgres psql -tc "SELECT 1 FROM pg_roles WHERE rolname='${PG_USER}'" \
  | grep -q 1 || sudo -u postgres psql -c \
  "CREATE USER ${PG_USER} WITH PASSWORD '${PG_PASS}';" >/dev/null

sudo -u postgres psql -tc "SELECT 1 FROM pg_database WHERE datname='${PG_DB}'" \
  | grep -q 1 || sudo -u postgres psql -c \
  "CREATE DATABASE ${PG_DB} OWNER ${PG_USER};" >/dev/null

SA_DB_URL="postgresql://${PG_USER}:${PG_PASS}@localhost:5432/${PG_DB}"
echo "  DB: ${PG_DB} / user: ${PG_USER}"

# Create tenants table
sudo -u postgres psql -d "${PG_DB}" -c "
  CREATE TABLE IF NOT EXISTS tenants (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    instance_id  TEXT UNIQUE NOT NULL,
    name         TEXT NOT NULL,
    api_domain   TEXT NOT NULL,
    admin_domain TEXT NOT NULL,
    api_port     INT  NOT NULL,
    admin_port   INT  NOT NULL,
    linux_user   TEXT NOT NULL,
    app_dir      TEXT NOT NULL,
    status       TEXT NOT NULL DEFAULT 'provisioned',
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
" >/dev/null 2>&1 && echo "  Tenants table ready." || echo "  (table already exists)"

# ── 7. .env for super admin ────────────────────────────────────────
echo "[7/9] Generating super-admin .env..."
ENV_FILE="${APP_DIR}/.env.super-admin"
if [ ! -f "${ENV_FILE}" ]; then
  JWT_SECRET=$(openssl rand -hex 32)
  SA_PASS=$(openssl rand -hex 8)
  cat > "${ENV_FILE}" <<EOF
# Super Admin — direct-ai-agents.com
NODE_ENV=production
INSTANCE_ID=sa
INSTANCE_NAME=DirectAIAgents

SA_API_PORT=${SA_API_PORT}
SA_APP_PORT=${SA_APP_PORT}
ADMIN_DOMAIN=${ADMIN_DOMAIN}
LANDING_DOMAIN=${LANDING_DOMAIN}

DATABASE_URL=${SA_DB_URL}

JWT_SECRET=${JWT_SECRET}
JWT_EXPIRES_IN=7d

SA_ADMIN_USERNAME=superadmin
SA_ADMIN_PASSWORD=${SA_PASS}

CONTACT_EMAIL=hello@direct-ai-agents.com
LOG_LEVEL=info
EOF
  chown "${LINUX_USER}:${LINUX_USER}" "${ENV_FILE}"
  chmod 600 "${ENV_FILE}"
  echo "  Created: ${ENV_FILE}"
else
  echo "  Already exists: ${ENV_FILE} — skipping"
  SA_PASS="(see existing .env.super-admin)"
fi

# ── 8. NGINX + TLS ────────────────────────────────────────────────
echo "[8/9] Configuring NGINX and obtaining TLS certificates..."

mkdir -p /var/www/certbot
rm -f /etc/nginx/sites-enabled/default

# Temporary HTTP config (needed for certbot webroot challenge)
cat > /etc/nginx/sites-available/platform-temp.conf <<NGINX
server {
    listen 80;
    listen [::]:80;
    server_name ${LANDING_DOMAIN} www.${LANDING_DOMAIN} ${ADMIN_DOMAIN};

    location /.well-known/acme-challenge/ {
        root /var/www/certbot;
    }
    location / {
        return 200 'provisioning...';
        add_header Content-Type text/plain;
    }
}
NGINX

ln -sf /etc/nginx/sites-available/platform-temp.conf /etc/nginx/sites-enabled/
nginx -t && systemctl reload nginx

# Obtain certs
echo "  Getting cert for ${LANDING_DOMAIN} + www.${LANDING_DOMAIN}..."
if [ ! -d "/etc/letsencrypt/live/${LANDING_DOMAIN}" ]; then
  certbot certonly --nginx \
    --non-interactive --agree-tos --email "${CERTBOT_EMAIL}" \
    -d "${LANDING_DOMAIN}" -d "www.${LANDING_DOMAIN}"
  echo "  Cert obtained: ${LANDING_DOMAIN}"
else
  echo "  Cert exists: ${LANDING_DOMAIN}"
fi

echo "  Getting cert for ${ADMIN_DOMAIN}..."
if [ ! -d "/etc/letsencrypt/live/${ADMIN_DOMAIN}" ]; then
  certbot certonly --nginx \
    --non-interactive --agree-tos --email "${CERTBOT_EMAIL}" \
    -d "${ADMIN_DOMAIN}"
  echo "  Cert obtained: ${ADMIN_DOMAIN}"
else
  echo "  Cert exists: ${ADMIN_DOMAIN}"
fi

# Install real NGINX config
rm -f /etc/nginx/sites-enabled/platform-temp.conf
rm -f /etc/nginx/sites-available/platform-temp.conf

cp "${APP_DIR}/infra/nginx/platform.conf" /etc/nginx/sites-available/platform.conf
ln -sf /etc/nginx/sites-available/platform.conf /etc/nginx/sites-enabled/
nginx -t && systemctl reload nginx
echo "  NGINX configured and reloaded."

# Enable certbot auto-renew
systemctl enable certbot.timer --quiet
systemctl start certbot.timer --quiet

# ── 9. Firewall ────────────────────────────────────────────────────
echo "[9/9] Configuring UFW firewall..."
ufw allow OpenSSH >/dev/null
ufw allow 'Nginx Full' >/dev/null
ufw --force enable >/dev/null
echo "  UFW enabled: SSH + Nginx Full"

# ── Summary ────────────────────────────────────────────────────────
echo ""
echo "╔══════════════════════════════════════════════════════╗"
echo "║  Provision complete!                                  ║"
echo "╚══════════════════════════════════════════════════════╝"
echo ""
echo "  Landing:     https://${LANDING_DOMAIN}"
echo "  Super Admin: https://${ADMIN_DOMAIN}"
echo "  App dir:     ${APP_DIR}"
echo "  Linux user:  ${LINUX_USER}"
echo ""
echo "  ┌─────────────────────────────────────────────────────┐"
echo "  │ DATABASE_URL=${SA_DB_URL}"
echo "  │ Super admin login:  superadmin / ${SA_PASS}"
echo "  │ Saved in: ${ENV_FILE}"
echo "  └─────────────────────────────────────────────────────┘"
echo ""
echo "  ══ MANUAL STEPS REMAINING ══"
echo ""
echo "  1. Switch to agentsadmin user:"
echo "     su - ${LINUX_USER}"
echo ""
echo "  2. Install dependencies:"
echo "     cd ${APP_DIR}"
echo "     npm install"
echo ""
echo "  3. (When super-admin app is ready) Start PM2:"
echo "     cp ${ENV_FILE} .env"
echo "     pm2 start ecosystem.super-admin.config.cjs"
echo "     pm2 save"
echo ""
echo "  4. Authenticate Claude Code (one-time per client later):"
echo "     claude auth login"
echo ""
echo "  5. Onboard first client (Status Blessed):"
echo "     CERTBOT_EMAIL=${CERTBOT_EMAIL} \\"
echo "     bash ${APP_DIR}/infra/scripts/provision-client.sh \\"
echo "       sb StatusBlessed api.status-blessed.com agent.status-blessed.com 3100 3101"
echo ""
