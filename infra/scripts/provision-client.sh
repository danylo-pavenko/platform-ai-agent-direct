#!/usr/bin/env bash
#
# provision-client.sh — Onboard a new client (tenant) onto the platform
#
# Legacy (custom domains — unchanged):
#   bash provision-client.sh <INSTANCE_ID> <CLIENT_NAME> <API_DOMAIN> <ADMIN_DOMAIN> <API_PORT> <ADMIN_PORT>
#
# Platform (auto api-{slug}.direct-ai-agents.com / agent-{slug}.direct-ai-agents.com):
#   bash provision-client.sh <INSTANCE_ID> <CLIENT_NAME> --platform <API_PORT> <ADMIN_PORT>
#   bash provision-client.sh <INSTANCE_ID> <CLIENT_NAME> --platform-auto
#
# Examples:
#   bash provision-client.sh blessed Blessed api.status-blessed.com agent.status-blessed.com 3100 3101
#   bash provision-client.sh cultura "Cultura Barbershop" --platform 3200 3201
#   bash provision-client.sh acme "Acme Store" --platform-auto
#
# See docs/TENANT-DOMAINS-AND-SCALING.md for DNS, wildcard TLS, and multi-server roadmap.
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/tenant-domains.sh
source "${SCRIPT_DIR}/lib/tenant-domains.sh"

META_DEFAULTS="${SCRIPT_DIR}/../platform-meta.defaults.env"
if [[ -f "${META_DEFAULTS}" ]]; then
  # shellcheck source=../platform-meta.defaults.env
  source "${META_DEFAULTS}"
fi

PLATFORM_MODE=false

# ── Args ──
if [[ "${3:-}" == "--platform" ]]; then
  PLATFORM_MODE=true
  INSTANCE_ID="${1:?Missing INSTANCE_ID}"
  CLIENT_NAME="${2:?Missing CLIENT_NAME}"
  API_PORT="${4:?Missing API_PORT (--platform mode)}"
  ADMIN_PORT="${5:?Missing ADMIN_PORT (--platform mode)}"
  tenant_domains_from_slug "${INSTANCE_ID}"
elif [[ "${3:-}" == "--platform-auto" ]]; then
  PLATFORM_MODE=true
  INSTANCE_ID="${1:?Missing INSTANCE_ID}"
  CLIENT_NAME="${2:?Missing CLIENT_NAME}"
  read -r API_PORT ADMIN_PORT < <(tenant_domains_next_free_port_pair)
  tenant_domains_from_slug "${INSTANCE_ID}"
else
  INSTANCE_ID="${1:?Missing INSTANCE_ID — run without args for usage}"
  CLIENT_NAME="${2:?Missing CLIENT_NAME}"
  API_DOMAIN="${3:?Missing API_DOMAIN}"
  ADMIN_DOMAIN="${4:?Missing ADMIN_DOMAIN}"
  API_PORT="${5:?Missing API_PORT}"
  ADMIN_PORT="${6:?Missing ADMIN_PORT}"
  tenant_domains_validate_instance_id "${INSTANCE_ID}" || {
    tenant_domains_usage
    exit 1
  }
fi

# ── Config ──
INSTANCE_ID_UPPER="${INSTANCE_ID^^}"
LINUX_USER="${INSTANCE_ID}"
# APP_DIR is derived from the user's home dir — always /home/{user}/platform-ai-agent-direct
# For existing users, we detect the actual home dir; for new users, default to /home/{user}
if id "${LINUX_USER}" &>/dev/null; then
  USER_HOME=$(getent passwd "${LINUX_USER}" | cut -d: -f6)
else
  USER_HOME="/home/${LINUX_USER}"
fi
APP_DIR="${USER_HOME}/platform-ai-agent-direct"

PG_DB="${INSTANCE_ID}_agent"
PG_USER="${INSTANCE_ID}_agent"
PLATFORM_REPO="${PLATFORM_REPO:-git@github.com:danylo-pavenko/platform-ai-agent-direct.git}"
CERTBOT_EMAIL="${CERTBOT_EMAIL:-}"

DOMAIN_MODE="legacy"
if [[ "${PLATFORM_MODE}" == true ]]; then
  DOMAIN_MODE="platform (${PLATFORM_BASE_DOMAIN})"
fi

echo "══════════════════════════════════════════════"
echo "  Platform — Provision Client: ${CLIENT_NAME}"
echo "  Instance ID: ${INSTANCE_ID_UPPER}"
echo "  Domain mode: ${DOMAIN_MODE}"
echo "  Linux user:  ${LINUX_USER}"
echo "  App dir:     ${APP_DIR}"
echo "  API:   https://${API_DOMAIN}"
echo "  Admin: https://${ADMIN_DOMAIN}"
echo "  Ports: ${API_PORT} / ${ADMIN_PORT}"
echo "  $(date '+%Y-%m-%d %H:%M:%S')"
echo "══════════════════════════════════════════════"

if [[ $EUID -ne 0 ]]; then
  echo "ERROR: Run as root"
  exit 1
fi

# ── Validate port uniqueness (skip if re-provisioning existing instance) ──
INSTANCE_EXISTS=false
if id "${LINUX_USER}" &>/dev/null || [ -d "${APP_DIR}/.git" ]; then
  INSTANCE_EXISTS=true
  echo "  Re-provisioning existing instance '${INSTANCE_ID}' — skipping port conflict check."
fi

if [ "${INSTANCE_EXISTS}" = false ]; then
  for port in "${API_PORT}" "${ADMIN_PORT}"; do
    if ss -tlnp | grep -q ":${port} "; then
      echo "ERROR: Port ${port} is already in use. Choose different ports."
      exit 1
    fi
  done
fi

# ── 1. Linux user ──
echo ""
echo "[1/8] Creating Linux user '${LINUX_USER}'..."
if ! id "${LINUX_USER}" &>/dev/null; then
  useradd -m -s /bin/bash "${LINUX_USER}"
  echo "  Created: ${LINUX_USER} (home: /home/${LINUX_USER})"
else
  echo "  Already exists: ${LINUX_USER}"
fi

# Re-resolve APP_DIR now that user definitely exists
USER_HOME=$(getent passwd "${LINUX_USER}" | cut -d: -f6)
APP_DIR="${USER_HOME}/platform-ai-agent-direct"

# ── 1b. SSH for git clone + admin login (from PROVISION_SOURCE_USER) ──
PROVISION_SOURCE_USER="${PROVISION_SOURCE_USER:-agentsadmin}"
if getent passwd "${PROVISION_SOURCE_USER}" &>/dev/null; then
  SOURCE_HOME=$(getent passwd "${PROVISION_SOURCE_USER}" | cut -d: -f6)
  mkdir -p "${USER_HOME}/.ssh"
  chown "${LINUX_USER}:${LINUX_USER}" "${USER_HOME}/.ssh"
  chmod 700 "${USER_HOME}/.ssh"

  # Inbound SSH: same keys that can log into agentsadmin can log into this tenant user.
  if [ -f "${SOURCE_HOME}/.ssh/authorized_keys" ]; then
    if [ ! -f "${USER_HOME}/.ssh/authorized_keys" ]; then
      cp "${SOURCE_HOME}/.ssh/authorized_keys" "${USER_HOME}/.ssh/authorized_keys"
    else
      # Merge without duplicating lines
      while IFS= read -r line || [ -n "$line" ]; do
        [[ -z "${line//[[:space:]]/}" ]] && continue
        grep -qxF "$line" "${USER_HOME}/.ssh/authorized_keys" 2>/dev/null || echo "$line" >> "${USER_HOME}/.ssh/authorized_keys"
      done < "${SOURCE_HOME}/.ssh/authorized_keys"
    fi
    chown "${LINUX_USER}:${LINUX_USER}" "${USER_HOME}/.ssh/authorized_keys"
    chmod 600 "${USER_HOME}/.ssh/authorized_keys"
    echo "  authorized_keys synced from ${PROVISION_SOURCE_USER} (SSH login as ${LINUX_USER})"
  fi

  # Outbound git: deploy keys copied only when tenant has none (git clone as tenant user).
  for KEY_TYPE in id_ed25519 id_rsa; do
    if [ ! -f "${USER_HOME}/.ssh/${KEY_TYPE}" ] && [ -f "${SOURCE_HOME}/.ssh/${KEY_TYPE}" ]; then
      cp "${SOURCE_HOME}/.ssh/${KEY_TYPE}" "${USER_HOME}/.ssh/${KEY_TYPE}"
      cp "${SOURCE_HOME}/.ssh/${KEY_TYPE}.pub" "${USER_HOME}/.ssh/${KEY_TYPE}.pub" 2>/dev/null || true
      chown "${LINUX_USER}:${LINUX_USER}" "${USER_HOME}/.ssh/${KEY_TYPE}" "${USER_HOME}/.ssh/${KEY_TYPE}.pub" 2>/dev/null || true
      chmod 600 "${USER_HOME}/.ssh/${KEY_TYPE}"
      echo "  SSH deploy key ${KEY_TYPE} copied from ${PROVISION_SOURCE_USER} (git)"
    fi
  done
  if [ -f "${SOURCE_HOME}/.ssh/known_hosts" ] && [ ! -f "${USER_HOME}/.ssh/known_hosts" ]; then
    cp "${SOURCE_HOME}/.ssh/known_hosts" "${USER_HOME}/.ssh/known_hosts"
    chown "${LINUX_USER}:${LINUX_USER}" "${USER_HOME}/.ssh/known_hosts"
    chmod 644 "${USER_HOME}/.ssh/known_hosts"
  fi
fi

# ── 2. PostgreSQL ──
echo "[2/8] Creating PostgreSQL database '${PG_DB}'..."
systemctl start postgresql

# Reuse existing password if re-provisioning
if [ -f "${APP_DIR}/.env" ]; then
  PG_PASS=$(grep '^DATABASE_URL=' "${APP_DIR}/.env" | sed -E 's|.*:([^@]+)@.*|\1|')
  echo "  Using existing DB password from .env"
else
  PG_PASS=$(openssl rand -base64 24 | tr -d '/+=' | head -c 32)
fi

sudo -u postgres psql -tc "SELECT 1 FROM pg_roles WHERE rolname='${PG_USER}'" | grep -q 1 || \
  sudo -u postgres psql -c "CREATE USER ${PG_USER} WITH PASSWORD '${PG_PASS}';"

sudo -u postgres psql -tc "SELECT 1 FROM pg_database WHERE datname='${PG_DB}'" | grep -q 1 || \
  sudo -u postgres psql -c "CREATE DATABASE ${PG_DB} OWNER ${PG_USER};"

DB_URL="postgresql://${PG_USER}:${PG_PASS}@localhost:5432/${PG_DB}"
echo "  Database: ${PG_DB}, User: ${PG_USER}"

# ── 3. Clone platform repo ──
echo "[3/8] Cloning platform repo to ${APP_DIR}..."
if [ -d "${APP_DIR}/.git" ]; then
  echo "  Repo already exists — pulling latest..."
  sudo -u "${LINUX_USER}" git -C "${APP_DIR}" pull --ff-only
elif [ -d "${APP_DIR}" ]; then
  # Dir exists but is not a git repo (e.g. partially set up) — clone into it
  echo "  Dir exists but is not a git repo — merging clone into it..."
  TMPDIR_CLONE=$(mktemp -d)
  sudo -u "${LINUX_USER}" git clone "${PLATFORM_REPO}" "${TMPDIR_CLONE}/repo"
  cp -a "${TMPDIR_CLONE}/repo/." "${APP_DIR}/"
  rm -rf "${TMPDIR_CLONE}"
  echo "  Cloned from ${PLATFORM_REPO}"
else
  sudo -u "${LINUX_USER}" git clone "${PLATFORM_REPO}" "${APP_DIR}"
  echo "  Cloned from ${PLATFORM_REPO}"
fi

# Ensure uploads dir and permissions
mkdir -p "${APP_DIR}/uploads"
chown -R "${LINUX_USER}:${LINUX_USER}" "${APP_DIR}"
chmod 750 "${APP_DIR}"

echo "  Installing Claude Code CLI for ${LINUX_USER} (idempotent)..."
if [ -f "${APP_DIR}/infra/scripts/setup-claude-cli.sh" ]; then
  sudo -u "${LINUX_USER}" bash "${APP_DIR}/infra/scripts/setup-claude-cli.sh"
else
  echo "  WARN: setup-claude-cli.sh not found — git pull main and re-run deploy-client.sh"
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

# ── Facebook / Instagram ──
# Meta Dashboard → App Settings → Basic: App ID + App Secret.
FACEBOOK_APP_ID=${PLATFORM_FACEBOOK_APP_ID:-}
FACEBOOK_APP_SECRET=${PLATFORM_FACEBOOK_APP_SECRET:-}
# Random secret string; must match Meta → Webhooks → Verify Token.
IG_WEBHOOK_VERIFY_TOKEN=${INSTANCE_ID}-verify-$(date +%Y)
# Page + IG tokens are filled by OAuth (Settings → Meta in admin) and stored in DB.

# ── Telegram ──
TELEGRAM_BOT_TOKEN=
TELEGRAM_MANAGER_GROUP_ID=
TELEGRAM_ADMIN_PASSWORD=${TG_ADMIN_PASS}

# ── Claude ──
CLAUDE_MAX_CONCURRENCY=2
CLAUDE_TIMEOUT_MS=60000
CLAUDE_VOICE_TIMEOUT_MS=90000
CLAUDE_ADMIN_TIMEOUT_MS=120000
CLAUDE_MODEL=sonnet

# Retry IG/TG bot replies when Claude timed out or no outbound was sent
CONVERSATION_RETRY_ENABLED=true
CONVERSATION_RETRY_INTERVAL_MIN=5
CONVERSATION_RETRY_MIN_AGE_MS=120000
CONVERSATION_RETRY_MAX_AGE_MS=86400000
CONVERSATION_RETRY_BATCH_SIZE=15
CONVERSATION_RETRY_MAX_BOT_ATTEMPTS=3

# ── Auth ──
JWT_SECRET=${JWT_SECRET}
JWT_EXPIRES_IN=7d

# Shared secret between super-admin and this tenant backend.
# Keep empty to disable the supervisor chat endpoint.
SUPERVISOR_SHARED_SECRET=

# ── File storage ──
UPLOADS_DIR=${APP_DIR}/uploads

# ── Speech-to-text (local faster-whisper) ──
STT_ENABLED=true
WHISPER_SERVICE_URL=http://127.0.0.1:$((API_PORT + 5000))
WHISPER_SERVICE_PORT=$((API_PORT + 5000))
WHISPER_SERVICE_TOKEN=$(openssl rand -hex 24)
WHISPER_MODEL=small
WHISPER_LANGUAGE=uk
WHISPER_MAX_SECONDS=90
WHISPER_TIMEOUT_MS=120000
WHISPER_DEVICE=cpu
WHISPER_COMPUTE_TYPE=int8
WHISPER_CACHE_DIR=${APP_DIR}/.whisper-models

# Per-tenant knowledge dir (leave empty to auto-resolve to \$HOME/tenant_knowledge).
TENANT_KNOWLEDGE_DIR=

# ── Nova Poshta ──
NOVA_POSHTA_API_KEY=

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
WILDCARD_SSL_DIR="$(tenant_domains_resolve_ssl_cert_dir "${API_DOMAIN}" "${ADMIN_DOMAIN}")"
if [[ -n "${WILDCARD_SSL_DIR}" ]]; then
  ADMIN_SSL_DIR="${WILDCARD_SSL_DIR}"
  API_SSL_DIR="${WILDCARD_SSL_DIR}"
  echo "  Using platform wildcard cert: ${WILDCARD_SSL_DIR}"
else
  echo "  No wildcard cert for *.${PLATFORM_BASE_DOMAIN} — using per-domain certbot (HTTP-01)"
  if [[ -f "/etc/letsencrypt/live/${PLATFORM_TLS_CERT_NAME}/fullchain.pem" ]] \
    && ! tenant_domains_ssl_cert_covers_wildcard "/etc/letsencrypt/live/${PLATFORM_TLS_CERT_NAME}/fullchain.pem"; then
    echo "  NOTE: /etc/letsencrypt/live/${PLATFORM_TLS_CERT_NAME} is apex-only — it cannot cover api-*/agent-* subdomains."
    echo "        Run: CERTBOT_EMAIL=you@example.com bash infra/scripts/setup-platform-wildcard-tls.sh"
  fi
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

  ADMIN_SSL_DIR="$(tenant_domains_per_domain_cert_dir "${ADMIN_DOMAIN}")"
  API_SSL_DIR="$(tenant_domains_per_domain_cert_dir "${API_DOMAIN}")"
fi

# Install full HTTPS NGINX config
cat > "${NGINX_CONF}" <<NGINX
# ${CLIENT_NAME} (${INSTANCE_ID_UPPER}) — Admin SPA
server {
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    server_name ${ADMIN_DOMAIN};

    ssl_certificate     ${ADMIN_SSL_DIR}/fullchain.pem;
    ssl_certificate_key ${ADMIN_SSL_DIR}/privkey.pem;
    ssl_protocols       TLSv1.2 TLSv1.3;

    add_header X-Frame-Options "SAMEORIGIN" always;
    add_header X-Content-Type-Options "nosniff" always;

    # API proxy — /api/* → backend (strips /api prefix)
    location /api/ {
        proxy_pass http://127.0.0.1:${API_PORT}/;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
    }

    # Admin SPA
    location / {
        proxy_pass http://127.0.0.1:${ADMIN_PORT};
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }
}

# ${CLIENT_NAME} (${INSTANCE_ID_UPPER}) — Backend API + IG webhook
server {
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    server_name ${API_DOMAIN};

    ssl_certificate     ${API_SSL_DIR}/fullchain.pem;
    ssl_certificate_key ${API_SSL_DIR}/privkey.pem;
    ssl_protocols       TLSv1.2 TLSv1.3;

    client_max_body_size 10m;

    add_header X-Frame-Options "DENY" always;
    add_header X-Content-Type-Options "nosniff" always;

    location / {
        proxy_pass http://127.0.0.1:${API_PORT};
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
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
      linux_user = EXCLUDED.linux_user,
      app_dir = EXCLUDED.app_dir,
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
# Allow ${LINUX_USER} to reload nginx
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
echo "  │ DATABASE_URL written to ${ENV_FILE} (chmod 600)"
echo "  │ Admin password: ${ADMIN_PASS}  (also in .env DEFAULT_ADMIN_PASSWORD)"
echo "  │ TG admin pass:  ${TG_ADMIN_PASS}"
echo "  │ Linux login:    SSH key only (authorized_keys from ${PROVISION_SOURCE_USER})"
echo "  │                no Linux password is set or stored"
echo "  └──────────────────────────────────────────────────────────┘"
echo ""
echo "  REQUIRED MANUAL STEPS:"
echo ""
echo "  1. Fill in API credentials in .env:"
echo "     su - ${LINUX_USER}"
echo "     nano ${APP_DIR}/.env"
echo "     # Set: TELEGRAM_BOT_TOKEN, TELEGRAM_MANAGER_GROUP_ID"
echo "     # Set: CRM_PROVIDER + KEYCRM_API_KEY (if needed)"
echo ""
echo "  2. Authenticate Claude Code (CLI is installed automatically; OAuth is manual):"
echo "     Tenant admin → Settings → Claude login"
echo "     or: su - ${LINUX_USER} && claude auth login"
echo ""
echo "  3. Deploy the app:"
echo "     su - ${LINUX_USER}"
echo "     bash ${APP_DIR}/infra/scripts/deploy-client.sh"
echo ""
echo "  4. Instagram webhooks:"
if [[ "${PLATFORM_MODE}" == true ]]; then
  echo "     Platform hub (recommended): https://admin.${PLATFORM_BASE_DOMAIN}/webhooks/instagram"
  echo "     Direct tenant URL (fallback): https://${API_DOMAIN}/webhooks/instagram"
else
  echo "     URL: https://${API_DOMAIN}/webhooks/instagram"
fi
echo "     Verify token: see IG_WEBHOOK_VERIFY_TOKEN in .env (tenant) or PLATFORM_WEBHOOK_VERIFY_TOKEN (hub)"
echo ""
