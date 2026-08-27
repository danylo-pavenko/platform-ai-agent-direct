#!/usr/bin/env bash
#
# deprovision-client.sh — Fully remove a tenant from this host (reverse of provision-client.sh).
#
# Usage (root only):
#   bash deprovision-client.sh <INSTANCE_ID> [API_DOMAIN] [ADMIN_DOMAIN]
#
# Examples:
#   bash deprovision-client.sh cultura
#   bash deprovision-client.sh blessed api.status-blessed.com agent.status-blessed.com
#
# Idempotent: missing user/DB/nginx are skipped with a note.
# Does NOT remove: platform-pm2-startup binary, shared wildcard TLS, other tenants.
#
# Dry-run checklist (manual):
#   - Confirm INSTANCE_ID matches the Linux user you intend to remove
#   - Confirm no other services share that user/home
#   - After run: getent passwd <id> → empty; nginx -t OK; psql list no {id}_agent
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

INSTANCE_ID="${1:?Missing INSTANCE_ID — usage: deprovision-client.sh <INSTANCE_ID> [API_DOMAIN] [ADMIN_DOMAIN]}"
API_DOMAIN="${2:-}"
ADMIN_DOMAIN="${3:-}"

tenant_domains_validate_instance_id "${INSTANCE_ID}" || exit 1

LINUX_USER="${INSTANCE_ID}"
INSTANCE_ID_UPPER="${INSTANCE_ID^^}"
PG_DB="${INSTANCE_ID}_agent"
PG_USER="${INSTANCE_ID}_agent"
CREDS_FILE="/root/platform-tenant-credentials/${LINUX_USER}"
SUDOERS_FILE="/etc/sudoers.d/${LINUX_USER}-deploy"
NGINX_AVAILABLE="/etc/nginx/sites-available/${INSTANCE_ID}-agent.conf"
NGINX_ENABLED="/etc/nginx/sites-enabled/${INSTANCE_ID}-agent.conf"
DEPLOY_LOCK="/tmp/deploy-${INSTANCE_ID}.lock"

PROTECTED_USERS=(root postgres agentsadmin ubuntu nobody daemon sync bin sys)
for forbidden in "${PROTECTED_USERS[@]}"; do
  if [[ "${LINUX_USER}" == "${forbidden}" ]]; then
    echo "ERROR: Refusing to deprovision protected user '${LINUX_USER}'"
    exit 1
  fi
done

if [[ $EUID -ne 0 ]]; then
  echo "ERROR: Run as root"
  exit 1
fi

WARNINGS=0
warn() {
  echo "  WARN: $*"
  WARNINGS=$((WARNINGS + 1))
}

echo "══════════════════════════════════════════════"
echo "  Platform — DEPROVISION (DESTROY) Client"
echo "  Instance ID: ${INSTANCE_ID_UPPER}"
echo "  Linux user:  ${LINUX_USER}"
echo "  Postgres:    ${PG_DB} / ${PG_USER}"
echo "  Nginx:       ${INSTANCE_ID}-agent.conf"
if [[ -n "${API_DOMAIN}" ]]; then
  echo "  API domain:  ${API_DOMAIN}"
fi
if [[ -n "${ADMIN_DOMAIN}" ]]; then
  echo "  Admin domain:${ADMIN_DOMAIN}"
fi
echo "  $(date '+%Y-%m-%d %H:%M:%S')"
echo "══════════════════════════════════════════════"
echo ""
echo "THIS IS DESTRUCTIVE. Home, DB, nginx, PM2 for this tenant will be removed."
echo ""

# ── 1. Stop PM2 + systemd unit ──
echo "[1/7] Stopping PM2 / systemd for '${LINUX_USER}'..."
if id "${LINUX_USER}" &>/dev/null; then
  USER_HOME=$(getent passwd "${LINUX_USER}" | cut -d: -f6)
  if [[ -z "${USER_HOME}" || "${USER_HOME}" == "/" || "${USER_HOME}" == "/root" ]]; then
    echo "ERROR: Refusing unsafe home path '${USER_HOME}' for ${LINUX_USER}"
    exit 1
  fi

  # Delete named apps first (best-effort), then kill the daemon.
  if sudo -u "${LINUX_USER}" bash -c 'command -v pm2 >/dev/null 2>&1'; then
    echo "  pm2 delete ${INSTANCE_ID_UPPER}-* (best-effort)"
    sudo -u "${LINUX_USER}" bash -c \
      "pm2 delete ${INSTANCE_ID_UPPER}-api ${INSTANCE_ID_UPPER}-bot ${INSTANCE_ID_UPPER}-sync ${INSTANCE_ID_UPPER}-admin ${INSTANCE_ID_UPPER}-whisper 2>/dev/null || true"
    sudo -u "${LINUX_USER}" bash -c 'pm2 save --force 2>/dev/null || true' || true
    sudo -u "${LINUX_USER}" bash -c 'pm2 kill 2>/dev/null || true' || true
    echo "  PM2 daemon stopped for ${LINUX_USER}"
  else
    echo "  pm2 not found for ${LINUX_USER} — skip"
  fi
else
  USER_HOME="/home/${LINUX_USER}"
  echo "  Linux user '${LINUX_USER}' does not exist — skip PM2"
fi

PM2_UNIT="pm2-${LINUX_USER}.service"
if systemctl list-unit-files "${PM2_UNIT}" &>/dev/null || [[ -f "/etc/systemd/system/${PM2_UNIT}" ]]; then
  systemctl disable --now "${PM2_UNIT}" 2>/dev/null || true
  rm -f "/etc/systemd/system/${PM2_UNIT}"
  systemctl daemon-reload 2>/dev/null || true
  echo "  Removed systemd unit ${PM2_UNIT}"
else
  echo "  No systemd unit ${PM2_UNIT}"
fi

# ── 2. Nginx site ──
echo "[2/7] Removing nginx site '${INSTANCE_ID}-agent'..."
NGINX_CHANGED=false
if [[ -L "${NGINX_ENABLED}" || -f "${NGINX_ENABLED}" ]]; then
  rm -f "${NGINX_ENABLED}"
  NGINX_CHANGED=true
  echo "  Removed ${NGINX_ENABLED}"
fi
if [[ -f "${NGINX_AVAILABLE}" ]]; then
  rm -f "${NGINX_AVAILABLE}"
  NGINX_CHANGED=true
  echo "  Removed ${NGINX_AVAILABLE}"
fi
# Backup files from update-nginx.sh
shopt -s nullglob
for bak in /etc/nginx/sites-available/"${INSTANCE_ID}"-agent.conf.bak.*; do
  rm -f "${bak}"
  NGINX_CHANGED=true
  echo "  Removed ${bak}"
done
shopt -u nullglob

if [[ "${NGINX_CHANGED}" == true ]]; then
  if nginx -t 2>/dev/null; then
    systemctl reload nginx
    echo "  nginx reloaded"
  else
    warn "nginx -t failed after removing site — fix manually before reload"
  fi
else
  echo "  No nginx site for ${INSTANCE_ID}"
fi

# ── 3. Legacy per-domain TLS (never touch platform wildcard) ──
echo "[3/7] Legacy TLS cleanup (best-effort)..."
delete_cert_if_safe() {
  local domain="$1"
  [[ -n "${domain}" ]] || return 0
  if tenant_domains_is_platform_host "${domain}"; then
    echo "  Skip platform host cert for ${domain} (shared wildcard)"
    return 0
  fi
  local live="/etc/letsencrypt/live/${domain}"
  if [[ ! -d "${live}" ]]; then
    echo "  No cert dir for ${domain}"
    return 0
  fi
  if command -v certbot >/dev/null 2>&1; then
    echo "  certbot delete --cert-name ${domain}"
    certbot delete --cert-name "${domain}" --non-interactive 2>/dev/null \
      || warn "certbot delete failed for ${domain}"
  else
    warn "certbot not installed — left ${live}"
  fi
}

if [[ -n "${API_DOMAIN}" || -n "${ADMIN_DOMAIN}" ]]; then
  delete_cert_if_safe "${API_DOMAIN}"
  if [[ -n "${ADMIN_DOMAIN}" && "${ADMIN_DOMAIN}" != "${API_DOMAIN}" ]]; then
    delete_cert_if_safe "${ADMIN_DOMAIN}"
  fi
else
  echo "  No API/ADMIN domains passed — skip certbot"
fi

# ── 4. PostgreSQL ──
echo "[4/7] Dropping PostgreSQL database/role..."
systemctl start postgresql 2>/dev/null || true
if command -v sudo >/dev/null 2>&1 && getent passwd postgres &>/dev/null; then
  # Terminate sessions then drop
  sudo -u postgres psql -v ON_ERROR_STOP=1 -c \
    "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${PG_DB}' AND pid <> pg_backend_pid();" \
    >/dev/null 2>&1 || true
  if sudo -u postgres psql -tc "SELECT 1 FROM pg_database WHERE datname='${PG_DB}'" | grep -q 1; then
    sudo -u postgres psql -c "DROP DATABASE ${PG_DB};"
    echo "  Dropped database ${PG_DB}"
  else
    echo "  Database ${PG_DB} does not exist"
  fi
  if sudo -u postgres psql -tc "SELECT 1 FROM pg_roles WHERE rolname='${PG_USER}'" | grep -q 1; then
    sudo -u postgres psql -c "DROP ROLE ${PG_USER};"
    echo "  Dropped role ${PG_USER}"
  else
    echo "  Role ${PG_USER} does not exist"
  fi
else
  warn "postgres user/psql unavailable — skipped DB drop"
fi

# ── 5. Credentials, sudoers, locks ──
echo "[5/7] Removing credentials / sudoers / locks..."
if [[ -f "${CREDS_FILE}" ]]; then
  rm -f "${CREDS_FILE}"
  echo "  Removed ${CREDS_FILE}"
else
  echo "  No credentials file"
fi
if [[ -f "${SUDOERS_FILE}" ]]; then
  rm -f "${SUDOERS_FILE}"
  echo "  Removed ${SUDOERS_FILE}"
else
  echo "  No sudoers drop-in"
fi
rm -f "${DEPLOY_LOCK}" 2>/dev/null || true
echo "  Cleared ${DEPLOY_LOCK} (if any)"

# ── 6. Linux user + home ──
echo "[6/7] Removing Linux user '${LINUX_USER}'..."
# Re-check home is only under /home/<user>
EXPECTED_HOME="/home/${LINUX_USER}"
if id "${LINUX_USER}" &>/dev/null; then
  ACTUAL_HOME=$(getent passwd "${LINUX_USER}" | cut -d: -f6)
  if [[ "${ACTUAL_HOME}" != "${EXPECTED_HOME}" ]]; then
    echo "ERROR: Home '${ACTUAL_HOME}' is not ${EXPECTED_HOME} — refusing userdel -r"
    exit 1
  fi
  # Kill leftover processes owned by the user
  pkill -u "${LINUX_USER}" 2>/dev/null || true
  sleep 1
  pkill -9 -u "${LINUX_USER}" 2>/dev/null || true

  if userdel -r "${LINUX_USER}" 2>/dev/null; then
    echo "  userdel -r ${LINUX_USER} OK"
  else
    warn "userdel -r failed — trying userdel then rm home"
    userdel "${LINUX_USER}" 2>/dev/null || warn "userdel ${LINUX_USER} failed"
  fi
else
  echo "  User already absent"
fi

if [[ -d "${EXPECTED_HOME}" ]]; then
  echo "  Removing leftover home ${EXPECTED_HOME}"
  rm -rf "${EXPECTED_HOME}"
fi

# ── 7. Summary ──
echo "[7/7] Summary"
LEFT=0
if id "${LINUX_USER}" &>/dev/null; then
  echo "  LEFT: Linux user ${LINUX_USER}"
  LEFT=1
fi
if [[ -d "${EXPECTED_HOME}" ]]; then
  echo "  LEFT: ${EXPECTED_HOME}"
  LEFT=1
fi
if [[ -f "${NGINX_AVAILABLE}" || -f "${NGINX_ENABLED}" ]]; then
  echo "  LEFT: nginx site files"
  LEFT=1
fi
if getent passwd postgres &>/dev/null; then
  if sudo -u postgres psql -tc "SELECT 1 FROM pg_database WHERE datname='${PG_DB}'" 2>/dev/null | grep -q 1; then
    echo "  LEFT: database ${PG_DB}"
    LEFT=1
  fi
  if sudo -u postgres psql -tc "SELECT 1 FROM pg_roles WHERE rolname='${PG_USER}'" 2>/dev/null | grep -q 1; then
    echo "  LEFT: role ${PG_USER}"
    LEFT=1
  fi
fi

echo ""
if [[ "${LEFT}" -ne 0 ]]; then
  echo "[✗ deprovision incomplete — see LEFT items above]"
  exit 1
fi

if [[ "${WARNINGS}" -gt 0 ]]; then
  echo "[✓ deprovision finished with ${WARNINGS} warning(s)]"
else
  echo "[✓ deprovision finished successfully]"
fi
exit 0
