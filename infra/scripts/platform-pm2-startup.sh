#!/usr/bin/env bash
#
# platform-pm2-startup — Configure systemd so a tenant user's PM2 dump
# resurrects on boot (`pm2 startup` + unit enable).
#
# Must run as root. Idempotent.
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

if ! command -v pm2 >/dev/null 2>&1; then
  echo "ERROR: pm2 not found in PATH (${PATH})" >&2
  exit 1
fi

# pm2 prints + installs the systemd unit when invoked as root with -u/--hp.
pm2 startup systemd -u "${LINUX_USER}" --hp "${HOME_DIR}"

UNIT="pm2-${LINUX_USER}.service"
if systemctl is-enabled "${UNIT}" &>/dev/null; then
  echo "OK: ${UNIT} is enabled"
else
  # Some pm2 versions leave the unit disabled until explicit enable.
  if systemctl list-unit-files "${UNIT}" 2>/dev/null | grep -q "${UNIT}"; then
    systemctl enable --now "${UNIT}" 2>/dev/null || systemctl enable "${UNIT}" || true
  fi
  if systemctl is-enabled "${UNIT}" &>/dev/null; then
    echo "OK: ${UNIT} enabled"
  else
    echo "WARN: ${UNIT} not reported as enabled — check: systemctl status ${UNIT}" >&2
  fi
fi
