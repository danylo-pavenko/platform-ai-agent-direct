#!/usr/bin/env bash
#
# platform-pm2-startup — Configure systemd so a tenant user's PM2 dump
# resurrects on boot (`pm2 startup` + unit enable + initial dump).
#
# Must run as root. Idempotent — safe on re-provision and from deploy.
#
# Usage:
#   platform-pm2-startup <linux_user> <home_dir>
#
# Installed to /usr/local/sbin/ during provision-client.sh so tenant
# sudoers can call it passwordless from deploy-client.sh.
#
set -euo pipefail

if [[ $EUID -ne 0 ]]; then
  echo "ERROR: Run as root" >&2
  exit 1
fi

LINUX_USER="${1:?Usage: platform-pm2-startup <linux_user> <home_dir>}"
HOME_DIR="${2:?Usage: platform-pm2-startup <linux_user> <home_dir>}"

if ! id "${LINUX_USER}" &>/dev/null; then
  echo "ERROR: User '${LINUX_USER}' does not exist" >&2
  exit 1
fi

EXPECTED_HOME="$(getent passwd "${LINUX_USER}" | cut -d: -f6)"
if [[ "${HOME_DIR}" != "${EXPECTED_HOME}" ]]; then
  echo "ERROR: home_dir mismatch for ${LINUX_USER}: got '${HOME_DIR}', expected '${EXPECTED_HOME}'" >&2
  exit 1
fi

export PATH="/usr/local/bin:/usr/bin:/bin:${PATH:-}"

ensure_pm2_installed() {
  if command -v pm2 >/dev/null 2>&1; then
    echo "  pm2: $(pm2 -v) ($(command -v pm2))"
    return 0
  fi
  if ! command -v npm >/dev/null 2>&1; then
    echo "ERROR: pm2 and npm missing — install Node.js/npm first (provision-server.sh)" >&2
    exit 1
  fi
  echo "  pm2 not found — installing globally via npm..."
  npm install -g pm2
  hash -r 2>/dev/null || true
  if ! command -v pm2 >/dev/null 2>&1; then
    echo "ERROR: pm2 install finished but binary not on PATH (${PATH})" >&2
    exit 1
  fi
  echo "  pm2: $(pm2 -v) ($(command -v pm2))"
}

ensure_pm2_installed

PM2_BIN="$(command -v pm2)"
PM2_DIR="$(dirname "${PM2_BIN}")"
export PATH="${PM2_DIR}:/usr/local/bin:/usr/bin:/bin:${PATH}"

# Tenant dump / logs live under ~/.pm2
mkdir -p "${HOME_DIR}/.pm2"
chown -R "${LINUX_USER}:${LINUX_USER}" "${HOME_DIR}/.pm2"
chmod 755 "${HOME_DIR}/.pm2"

UNIT="pm2-${LINUX_USER}.service"

echo "  Configuring systemd unit ${UNIT}..."
# As root with -u/--hp, PM2 writes the unit and enables resurrect-on-boot.
# Capture output for logs; do not pipe to head (breaks exit status with pipefail).
STARTUP_LOG="$(mktemp)"
if ! env PATH="${PATH}" pm2 startup systemd -u "${LINUX_USER}" --hp "${HOME_DIR}" >"${STARTUP_LOG}" 2>&1; then
  cat "${STARTUP_LOG}" >&2
  rm -f "${STARTUP_LOG}"
  echo "ERROR: pm2 startup failed for ${LINUX_USER}" >&2
  exit 1
fi
cat "${STARTUP_LOG}"
rm -f "${STARTUP_LOG}"

systemctl daemon-reload

if systemctl list-unit-files "${UNIT}" 2>/dev/null | grep -q "${UNIT}"; then
  systemctl enable "${UNIT}"
else
  echo "ERROR: ${UNIT} was not created by pm2 startup" >&2
  echo "       Check: ls /etc/systemd/system/pm2-*.service" >&2
  exit 1
fi

# Seed an empty (or current) dump so first reboot has a valid resurrect target.
# --force avoids interactive confirm when dump already exists.
echo "  Initializing PM2 dump for ${LINUX_USER}..."
sudo -u "${LINUX_USER}" -H env HOME="${HOME_DIR}" PATH="${PATH}" \
  bash -lc 'pm2 ping >/dev/null 2>&1 || true; pm2 save --force' \
  || sudo -u "${LINUX_USER}" -H env HOME="${HOME_DIR}" PATH="${PATH}" \
       bash -lc 'pm2 save' \
  || echo "  WARN: pm2 save as ${LINUX_USER} failed (deploy will save after start)"

if ! systemctl is-enabled "${UNIT}" >/dev/null 2>&1; then
  echo "ERROR: ${UNIT} is not enabled after setup" >&2
  systemctl status "${UNIT}" --no-pager -l 2>&1 | head -30 >&2 || true
  exit 1
fi

ENABLED_STATE="$(systemctl is-enabled "${UNIT}" 2>/dev/null || echo unknown)"
ACTIVE_STATE="$(systemctl is-active "${UNIT}" 2>/dev/null || echo inactive)"
echo "OK: ${UNIT} enabled=${ENABLED_STATE} active=${ACTIVE_STATE}"
echo "    After deploy + pm2 save, reboot will resurrect processes for ${LINUX_USER}."
