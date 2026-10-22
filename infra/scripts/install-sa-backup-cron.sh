#!/usr/bin/env bash
#
# install-sa-backup-cron.sh — Nightly tenant DB backups from the Super Admin host.
#
#   bash infra/scripts/install-sa-backup-cron.sh
#   bash infra/scripts/install-sa-backup-cron.sh --remove
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
SA_DIR="${PROJECT_ROOT}/apps/super-admin"
RUNNER="${SA_DIR}/src/scripts/run-scheduled-backups.ts"
LOG_DIR="${HOME}/.pm2/logs"
LOG_FILE="${LOG_DIR}/sa-backups-cron.log"
MARKER="# platform-sa-tenant-backups"
# 02:15 local server time
CRON_LINE="15 2 * * * cd ${SA_DIR} && /usr/bin/env npx tsx ${RUNNER} >>${LOG_FILE} 2>&1 ${MARKER}"

if [ ! -f "${RUNNER}" ]; then
  echo "ERROR: ${RUNNER} not found"
  exit 1
fi

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
  echo "Removed tenant backup cron (${MARKER})."
  exit 0
fi

{
  if [ -n "${FILTERED}" ]; then
    printf '%s\n' "${FILTERED}"
  fi
  printf '%s\n' "${CRON_LINE}"
} | crontab -

echo "Installed nightly tenant DB backup cron:"
echo "  ${CRON_LINE}"
echo "Log: ${LOG_FILE}"
echo "Test: cd ${SA_DIR} && npx tsx ${RUNNER}"
crontab -l | grep -F "${MARKER}" || true
