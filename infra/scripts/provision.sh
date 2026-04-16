#!/usr/bin/env bash
#
# provision.sh — One-time VPS setup for Status Blessed AI Agent
#
# Run as root on a fresh Ubuntu 22.04+ / 24.04 VPS:
#   curl -sL <raw-url> | bash
#   — or —
#   bash infra/scripts/provision.sh
#
# Prerequisites: DNS A-records for agent.status-blessed.com and
#                api.status-blessed.com already pointing to this server's IP.
#
set -euo pipefail

# ── Config ──
APP_USER="sbagent"
APP_DIR="/opt/sb-agent"
NODE_VERSION="20"
PG_DB="sb_agent"
PG_USER="sb_agent"
DOMAINS=("agent.status-blessed.com" "api.status-blessed.com")
CERTBOT_EMAIL="${CERTBOT_EMAIL:-}"

echo "══════════════════════════════════════"
echo "  Status Blessed Agent — VPS Provision"
echo "══════════════════════════════════════"

# ── 1. System packages ──
echo "[1/8] Installing system packages..."
apt-get update -qq
apt-get install -y -qq \
  curl git build-essential nginx certbot python3-certbot-nginx \
  postgresql postgresql-contrib ufw

# ── 2. Node.js via NodeSource ──
echo "[2/8] Installing Node.js ${NODE_VERSION}..."
if ! command -v node &>/dev/null || [[ "$(node -v)" != v${NODE_VERSION}* ]]; then
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_VERSION}.x" | bash -
  apt-get install -y -qq nodejs
fi
echo "  Node: $(node -v), npm: $(npm -v)"

# ── 3. PM2 ──
echo "[3/8] Installing PM2..."
npm install -g pm2

# ── 4. App user ──
echo "[4/8] Creating app user '${APP_USER}'..."
if ! id "${APP_USER}" &>/dev/null; then
  useradd -m -s /bin/bash "${APP_USER}"
fi
mkdir -p "${APP_DIR}" "${APP_DIR}/uploads"
chown -R "${APP_USER}:${APP_USER}" "${APP_DIR}"

# ── 5. PostgreSQL ──
echo "[5/8] Configuring PostgreSQL..."
systemctl enable postgresql
systemctl start postgresql

# Generate a random password
PG_PASS=$(openssl rand -base64 24 | tr -d '/+=' | head -c 32)

sudo -u postgres psql -tc "SELECT 1 FROM pg_roles WHERE rolname='${PG_USER}'" | grep -q 1 || \
  sudo -u postgres psql -c "CREATE USER ${PG_USER} WITH PASSWORD '${PG_PASS}';"

sudo -u postgres psql -tc "SELECT 1 FROM pg_database WHERE datname='${PG_DB}'" | grep -q 1 || \
  sudo -u postgres psql -c "CREATE DATABASE ${PG_DB} OWNER ${PG_USER};"

echo ""
echo "  ┌──────────────────────────────────────────┐"
echo "  │ DATABASE_URL=postgresql://${PG_USER}:${PG_PASS}@localhost:5432/${PG_DB}"
echo "  │ Save this — you'll need it for .env       │"
echo "  └──────────────────────────────────────────┘"
echo ""

# ── 6. Firewall ──
echo "[6/8] Configuring UFW firewall..."
ufw allow OpenSSH
ufw allow 'Nginx Full'
ufw --force enable

# ── 7. Nginx ──
echo "[7/8] Configuring Nginx..."
rm -f /etc/nginx/sites-enabled/default

# Temporary HTTP-only config for certbot to work
cat > /etc/nginx/sites-available/sb-agent-temp.conf <<'NGINX'
server {
    listen 80;
    listen [::]:80;
    server_name agent.status-blessed.com api.status-blessed.com;

    location /.well-known/acme-challenge/ {
        root /var/www/certbot;
    }

    location / {
        return 200 'waiting for TLS setup';
        add_header Content-Type text/plain;
    }
}
NGINX

ln -sf /etc/nginx/sites-available/sb-agent-temp.conf /etc/nginx/sites-enabled/
mkdir -p /var/www/certbot
nginx -t && systemctl reload nginx

# ── 8. TLS certificates ──
echo "[8/8] Obtaining TLS certificates..."
if [ -z "${CERTBOT_EMAIL}" ]; then
  echo "  CERTBOT_EMAIL not set. Usage:"
  echo "    CERTBOT_EMAIL=you@example.com bash provision.sh"
  echo ""
  read -rp "  Enter email for Let's Encrypt: " CERTBOT_EMAIL
fi

for domain in "${DOMAINS[@]}"; do
  if [ ! -d "/etc/letsencrypt/live/${domain}" ]; then
    certbot certonly --nginx \
      --non-interactive \
      --agree-tos \
      --email "${CERTBOT_EMAIL}" \
      -d "${domain}"
    echo "  ✓ Certificate obtained for ${domain}"
  else
    echo "  ✓ Certificate already exists for ${domain}"
  fi
done

# Now install the real nginx config
rm -f /etc/nginx/sites-enabled/sb-agent-temp.conf
rm -f /etc/nginx/sites-available/sb-agent-temp.conf

# Copy the real config (assumes repo is cloned to APP_DIR)
if [ -f "${APP_DIR}/infra/nginx/sb-agent.conf" ]; then
  cp "${APP_DIR}/infra/nginx/sb-agent.conf" /etc/nginx/sites-available/sb-agent.conf
else
  echo "  ⚠ Nginx config not found at ${APP_DIR}/infra/nginx/sb-agent.conf"
  echo "    Copy it manually after cloning the repo."
fi
ln -sf /etc/nginx/sites-available/sb-agent.conf /etc/nginx/sites-enabled/
nginx -t && systemctl reload nginx

# ── Auto-renew certs ──
systemctl enable certbot.timer

# ── Done ──
echo ""
echo "══════════════════════════════════════"
echo "  Provision complete!"
echo "══════════════════════════════════════"
echo ""
echo "  Next steps:"
echo "  1. Clone repo:   su - ${APP_USER} -c 'git clone <repo-url> ${APP_DIR}'"
echo "  2. Create .env:  cp ${APP_DIR}/.env.example ${APP_DIR}/.env && nano ${APP_DIR}/.env"
echo "  3. Deploy:       su - ${APP_USER} -c 'bash ${APP_DIR}/infra/scripts/deploy.sh'"
echo ""
echo "  DATABASE_URL=postgresql://${PG_USER}:${PG_PASS}@localhost:5432/${PG_DB}"
echo ""
