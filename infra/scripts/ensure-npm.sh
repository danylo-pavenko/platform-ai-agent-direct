#!/usr/bin/env bash
# ensure-npm.sh — Idempotent: install/upgrade global npm to TARGET_NPM.
# Safe to source or run; never fails the parent script hard (warns instead).
#
# Tenant users cannot write to NodeSource system prefix — skip upgrade quietly
# when the global root is not writable (root/provision paths still upgrade).
#
# Usage:
#   bash infra/scripts/ensure-npm.sh
#   TARGET_NPM=11.18.0 bash infra/scripts/ensure-npm.sh
#
set -u

TARGET_NPM="${TARGET_NPM:-11.18.0}"

if ! command -v npm >/dev/null 2>&1; then
  echo "  WARN: npm not found — skip ensure-npm"
  return 0 2>/dev/null || exit 0
fi

CURRENT_NPM="$(npm -v 2>/dev/null || echo '')"
if [ "${CURRENT_NPM}" = "${TARGET_NPM}" ]; then
  echo "  npm ${CURRENT_NPM} (ok)"
  return 0 2>/dev/null || exit 0
fi

GLOBAL_ROOT="$(npm root -g 2>/dev/null || true)"
if [ -z "${GLOBAL_ROOT}" ] || [ ! -w "${GLOBAL_ROOT}" ]; then
  # Also check parent of global bin (e.g. /usr/lib/node_modules may exist but
  # npm itself lives under a root-owned prefix).
  NPM_PREFIX="$(npm prefix -g 2>/dev/null || true)"
  if [ -z "${NPM_PREFIX}" ] || [ ! -w "${NPM_PREFIX}" ]; then
    echo "  npm ${CURRENT_NPM:-?} (system; skip upgrade — global prefix not writable)"
    echo "  Tip: pin npm@${TARGET_NPM} as root via provision-server / deploy-super-admin."
    return 0 2>/dev/null || exit 0
  fi
fi

echo "  npm ${CURRENT_NPM:-?} → ${TARGET_NPM}..."
if npm install -g "npm@${TARGET_NPM}" >/dev/null 2>&1; then
  echo "  npm $(npm -v) (updated)"
else
  echo "  WARN: could not install npm@${TARGET_NPM} globally. Continuing with npm ${CURRENT_NPM}."
fi

return 0 2>/dev/null || exit 0
