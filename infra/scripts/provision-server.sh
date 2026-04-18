#!/usr/bin/env bash
#
# provision-server.sh — One-time VPS base setup (OS level, no client-specific config)
#
# Run as root on a fresh Ubuntu 22.04+ / 24.04 VPS:
#   CERTBOT_EMAIL=you@example.com bash provision-server.sh
#
# What this does:
#   - Installs Node.js 20, PM2, Nginx, Certbot, PostgreSQL, UFW
#   - Configures firewall (SSH + HTTP/HTTPS)
#   - Sets up certbot auto-renew timer
#   - Creates /opt/agents/ directory for client instances
#   - Does NOT create any client users or databases
#
# After this script: run provision-super-admin.sh, then provision-client.sh per client.
#
set -euo pipefail

CERTBOT_EMAIL="${CERTBOT_EMAIL:-}"
NODE_VERSION="20"

echo "══════════════════════════════════════════════"
echo "  Platform AI Agent — Server Base Provision"
echo "  $(date '+%Y-%m-%d %H:%M:%S')"
echo "══════════════════════════════════════════════"

if [[ $EUID -ne 0 ]]; then
  echo "ERROR: Run as root (sudo bash provision-server.sh)"
  exit 1
fi

# ── 1. System packages ──
echo "[1/6] Installing system packages..."
apt-get update -qq
apt-get install -y -qq \
  curl git build-essential nginx certbot python3-certbot-nginx \
  postgresql postgresql-contrib ufw jq

# ── 2. Node.js via NodeSource ──
echo "[2/6] Installing Node.js ${NODE_VERSION}..."
if ! command -v node &>/dev/null || [[ "$(node -v)" != v${NODE_VERSION}* ]]; then
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_VERSION}.x" | bash -
  apt-get install -y -qq nodejs
fi
echo "  Node: $(node -v), npm: $(npm -v)"

# ── 3. PM2 ──
echo "[3/6] Installing PM2 globally..."
npm install -g pm2
echo "  PM2: $(pm2 -v)"

# ── 4. Directory structure ──
echo "[4/6] Creating /opt/agents/ directory..."
mkdir -p /opt/agents
chmod 755 /opt/agents

# ── 5. Firewall ──
echo "[5/6] Configuring UFW firewall..."
ufw allow OpenSSH
ufw allow 'Nginx Full'
ufw --force enable
echo "  UFW status:"
ufw status | grep -E "Status|OpenSSH|Nginx"

# ── 6. Certbot auto-renew ──
echo "[6/6] Enabling certbot auto-renew timer..."
systemctl enable certbot.timer
systemctl start certbot.timer

# ── Clean nginx default ──
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl reload nginx

echo ""
echo "══════════════════════════════════════════════"
echo "  Base provision complete!"
echo "══════════════════════════════════════════════"
echo ""
echo "  Next steps:"
echo "  1. Provision super admin:"
echo "     SUPER_ADMIN_DOMAIN=admin.yourplatform.com \\"
echo "     CERTBOT_EMAIL=${CERTBOT_EMAIL:-you@example.com} \\"
echo "     bash provision-super-admin.sh"
echo ""
echo "  2. Provision first client:"
echo "     bash provision-client.sh sb StatusBlessed api.status-blessed.com agent.status-blessed.com 3100 3101"
echo ""
