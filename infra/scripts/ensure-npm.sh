#!/usr/bin/env bash
# ensure-npm.sh — Idempotent: install/upgrade global npm to TARGET_NPM.
# Safe to source or run; never fails the parent script hard (warns instead).
#
# Usage:
#   bash infra/scripts/ensure-npm.sh
#   TARGET_NPM=11.18.0 bash infra/scripts/ensure-npm.sh
#
set -u

TARGET_NPM="${TARGET_NPM:-11.18.0}"

if ! command -v npm >/dev/null 2>&1; then
  echo "  WARN: npm not found — skip ensure-npm" >&2
  return 0 2>/dev/null || exit 0
fi

CURRENT_NPM="$(npm -v 2>/dev/null || echo '')"
if [ "${CURRENT_NPM}" = "${TARGET_NPM}" ]; then
  echo "  npm ${CURRENT_NPM} (ok)"
  return 0 2>/dev/null || exit 0
fi

echo "  npm ${CURRENT_NPM:-?} → ${TARGET_NPM}..."
if npm install -g "npm@${TARGET_NPM}" >/dev/null 2>&1; then
  echo "  npm $(npm -v) (updated)"
else
  echo "  WARN: could not install npm@${TARGET_NPM} globally (permissions?). Continuing with npm ${CURRENT_NPM}." >&2
fi

return 0 2>/dev/null || exit 0
