#!/usr/bin/env bash
#
# setup-client-admin.sh — Create or reset the admin user from .env credentials
#
# Run as the client's Linux user (e.g. agent_sb):
#   bash infra/scripts/setup-client-admin.sh
#
# Uses DEFAULT_ADMIN_USERNAME and DEFAULT_ADMIN_PASSWORD from .env.
# Idempotent — safe to run multiple times (upserts, does not duplicate).
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
cd "${PROJECT_ROOT}"

# ── Load .env ──
if [ ! -f .env ]; then
  echo "ERROR: .env not found in ${PROJECT_ROOT}. Configure it first."
  exit 1
fi

while IFS= read -r _line || [ -n "$_line" ]; do
  [[ "$_line" =~ ^[[:space:]]*# ]] && continue
  [[ -z "${_line// }" ]] && continue
  _key="${_line%%=*}"
  _val="${_line#*=}"
  _key="${_key//[[:space:]]/}"
  _val="${_val#\"}" ; _val="${_val%\"}"
  _val="${_val#\'}" ; _val="${_val%\'}"
  export "$_key=$_val"
done < .env

# ── Validate required vars ──
_missing=()
for _var in DATABASE_URL DEFAULT_ADMIN_USERNAME DEFAULT_ADMIN_PASSWORD; do
  [ -z "${!_var:-}" ] && _missing+=("${_var}")
done
if [ "${#_missing[@]}" -gt 0 ]; then
  echo "ERROR: Missing required .env fields: ${_missing[*]}"
  exit 1
fi

echo "══════════════════════════════════════════"
echo "  Setup admin: ${INSTANCE_NAME:-${INSTANCE_ID:-unknown}}"
echo "  Username: ${DEFAULT_ADMIN_USERNAME}"
echo "  $(date '+%Y-%m-%d %H:%M:%S')"
echo "══════════════════════════════════════════"

# ── Run seed (upserts admin user + default settings + system prompt) ──
cd apps/backend
npx prisma db seed
cd "${PROJECT_ROOT}"

echo ""
echo "  Done. Login at https://${ADMIN_DOMAIN:-<ADMIN_DOMAIN>}"
echo "  Username: ${DEFAULT_ADMIN_USERNAME}"
echo ""
