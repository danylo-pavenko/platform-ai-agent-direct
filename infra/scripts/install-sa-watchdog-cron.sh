#!/usr/bin/env bash
#
# install-sa-watchdog-cron.sh — Install agentsadmin crontab: SA health every 15m.
#
#   bash infra/scripts/install-sa-watchdog-cron.sh
#   bash infra/scripts/install-sa-watchdog-cron.sh --remove
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
WATCHDOG="${SCRIPT_DIR}/watchdog-super-admin.sh"
LOG_DIR="${HOME}/.pm2/logs"
LOG_FILE="${LOG_DIR}/sa-watchdog.log"
MARKER="# platform-sa-watchdog"
CRON_LINE="*/15 * * * * bash ${WATCHDOG} >>${LOG_FILE} 2>&1 ${MARKER}"

if [ ! -f "${WATCHDOG}" ]; then
  echo "ERROR: ${WATCHDOG} not found"
  exit 1
fi
chmod +x "${WATCHDOG}"

mkdir -p "${LOG_DIR}"

REMOVE=0
if [ "${1:-}" = "--remove" ]; then
  REMOVE=1
fi

EXISTING="$(crontab -l 2>/dev/null || true)"
FILTERED="$(printf '%s\n' "${EXISTING}" | grep -v "${MARKER}" || true)"

if [ "${REMOVE}" -eq 1 ]; then
  if [ -z "${FILTERED}" ]; then
    crontab -r 2>/dev/null || true
  else
    printf '%s\n' "${FILTERED}" | crontab -
  fi
  echo "Removed Super Admin watchdog cron (${MARKER})."
  exit 0
fi

{
  if [ -n "${FILTERED}" ]; then
    printf '%s\n' "${FILTERED}"
  fi
  printf '%s\n' "${CRON_LINE}"
} | crontab -

echo "Installed Super Admin watchdog cron:"
echo "  ${CRON_LINE}"
echo "Log: ${LOG_FILE}"
echo "Test once: bash ${WATCHDOG}"
crontab -l | grep -F "${MARKER}" || true
