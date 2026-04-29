#!/usr/bin/env bash
#
# deploy-client.sh — Pull latest, build, migrate, restart PM2
#
# Run as the client's Linux user (e.g. agent_sb):
#   bash infra/scripts/deploy-client.sh
#
# Can also be triggered by the super-admin dashboard via SSH.
# Idempotent — safe to run on every deploy.
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
cd "${PROJECT_ROOT}"

LOG_TS="$(date +%Y%m%d-%H%M%S)"
DEPLOY_LOG="/tmp/deploy-${LOG_TS}.log"
echo "Full deploy log: ${DEPLOY_LOG}"

# ── Load env ──
if [ ! -f .env ]; then
  echo "ERROR: .env not found in ${PROJECT_ROOT}. Configure it first."
  exit 1
fi
# Parse .env manually: handles unquoted values with spaces, inline comments,
# and always overrides stale values already set in the daemon environment.
while IFS= read -r _line || [ -n "$_line" ]; do
  # skip comment and blank lines
  [[ "$_line" =~ ^[[:space:]]*# ]] && continue
  [[ -z "${_line// }" ]] && continue
  _key="${_line%%=*}"          # everything before the first =
  _val="${_line#*=}"           # everything after the first =
  _key="${_key//[[:space:]]/}" # strip any spaces from key
  # strip surrounding quotes from value (optional quoting in .env)
  _val="${_val#\"}" ; _val="${_val%\"}"
  _val="${_val#\'}" ; _val="${_val%\'}"
  export "$_key=$_val"
done < .env

# Validate required fields so a misconfigured .env fails fast with a clear message.
_missing=()
for _var in INSTANCE_ID API_PORT ADMIN_PORT API_DOMAIN ADMIN_DOMAIN; do
  [ -z "${!_var:-}" ] && _missing+=("${_var}")
done
if [ "${#_missing[@]}" -gt 0 ]; then
  echo "ERROR: Missing required .env fields: ${_missing[*]}"
  echo "       Add them to ${PROJECT_ROOT}/.env and re-run."
  exit 1
fi

INSTANCE_ID_UPPER="${INSTANCE_ID^^}"

echo "══════════════════════════════════════════════"
echo "  Deploy: ${INSTANCE_NAME:-${INSTANCE_ID_UPPER}}"
echo "  $(date '+%Y-%m-%d %H:%M:%S')"
echo "══════════════════════════════════════════════"

# ── 1. Pull latest ──
echo "[1/9] Pulling latest code..."
git pull --ff-only

# ── 2. Install dependencies ──
echo "[2/9] Installing dependencies..."
npm ci --prefer-offline

# ── 3. Generate Prisma client ──
echo "[3/9] Generating Prisma client..."
cd apps/backend
npx prisma generate
cd "${PROJECT_ROOT}"

# ── 4. Run migrations ──
echo "[4/9] Running database migrations..."
cd apps/backend
npx prisma migrate deploy
cd "${PROJECT_ROOT}"

# ── 5. Seed admin user + default settings ──
echo "[5/9] Seeding admin user and default settings..."
cd apps/backend
npx prisma db seed
cd "${PROJECT_ROOT}"

# ── 6. Bootstrap tenant knowledge (seed missing files only) ──
echo "[6/9] Bootstrapping tenant knowledge..."
npm run bootstrap:knowledge

# ── 7. Build backend ──
echo "[7/9] Building backend..."
if ! npm run build:backend >>"${DEPLOY_LOG}" 2>&1; then
  echo "  Build failed — see ${DEPLOY_LOG}" >&2
  tail -40 "${DEPLOY_LOG}" >&2
  exit 1
fi
BACKEND_ENTRY="${PROJECT_ROOT}/apps/backend/dist/server.js"
if [ ! -f "${BACKEND_ENTRY}" ]; then
  echo "  ERROR: backend build artifact missing: ${BACKEND_ENTRY}" >&2
  exit 1
fi

# ── 8. Build admin panel ──
if [ -f apps/admin/vite.config.ts ] || [ -f apps/admin/vite.config.js ]; then
  echo "[8/9] Building admin panel..."
  if ! npm run build:admin >>"${DEPLOY_LOG}" 2>&1; then
    echo "  Admin build failed — see ${DEPLOY_LOG}" >&2
    tail -40 "${DEPLOY_LOG}" >&2
    exit 1
  fi
  ADMIN_INDEX="${PROJECT_ROOT}/apps/admin/dist/index.html"
  if [ ! -f "${ADMIN_INDEX}" ]; then
    echo "  ERROR: admin build artifact missing: ${ADMIN_INDEX}" >&2
    exit 1
  fi
else
  echo "[8/9] Admin panel not built yet — skipping"
fi

# ── 9. Restart PM2 ──
echo "[9/9] Restarting PM2 processes..."
PM2_PREFIX="${INSTANCE_ID_UPPER}"

# Use full restart (not graceful reload): cluster-mode reload performs a
# rolling handoff that static-file apps like the admin don't handle cleanly —
# new worker goes online but the port socket isn't re-bound, so nginx gets
# 502 until a manual `pm2 restart all`. Brief downtime during deploy is
# acceptable; correctness is not.
if pm2 describe "${PM2_PREFIX}-api" > /dev/null 2>&1; then
  pm2 restart ecosystem.config.cjs --update-env
else
  pm2 start ecosystem.config.cjs
fi

# ── Health check ──
echo ""
echo "  Waiting for processes to come up..."

wait_for_port() {
  local port="$1"
  local label="$2"
  local attempts=30
  local status
  for ((i = 1; i <= attempts; i++)); do
    # On connection failure curl writes "000" to stdout *and* exits non-zero.
    # The `|| printf '000'` fallback used to append a second "000", making
    # the check see "000000" and falsely pass. Keep only the first 3 chars.
    status=$(curl -s -o /dev/null -w "%{http_code}" --max-time 2 "http://localhost:${port}/" 2>/dev/null || printf '000')
    status="${status:0:3}"
    # Admin returns 200 on /, API returns 404 on / but 200 on /health.
    if [ "${status}" != "000" ]; then
      echo "  ${label} reachable on :${port} (HTTP ${status})"
      return 0
    fi
    sleep 1
  done
  echo "  WARN: ${label} did not respond on :${port} after ${attempts}s" >&2
  return 1
}

API_OK=0
ADMIN_OK=0

# API-specific /health check with retry.
for ((i = 1; i <= 30; i++)); do
  HTTP_STATUS=$(curl -s -o /dev/null -w "%{http_code}" --max-time 2 "http://localhost:${API_PORT}/health" 2>/dev/null || printf '000')
  HTTP_STATUS="${HTTP_STATUS:0:3}"
  if [ "${HTTP_STATUS}" = "200" ]; then
    echo "  API /health OK on :${API_PORT} (HTTP 200)"
    API_OK=1
    break
  fi
  sleep 1
done

if [ "${API_OK}" = "0" ]; then
  echo "  ERROR: API /health did not return 200 after 30s" >&2
  echo "  Tail of API logs:" >&2
  pm2 logs "${PM2_PREFIX}-api" --lines 20 --nostream 2>&1 || true
fi

if wait_for_port "${ADMIN_PORT}" "Admin"; then
  ADMIN_OK=1
else
  echo "  Tail of admin logs:" >&2
  pm2 logs "${PM2_PREFIX}-admin" --lines 20 --nostream 2>&1 || true
fi

if [ "${API_OK}" = "1" ] && [ "${ADMIN_OK}" = "1" ]; then
  pm2 save
  HEALTH_STATE="OK"
else
  HEALTH_STATE="FAILED"
fi

echo ""
echo "══════════════════════════════════════════════"
echo "  Deploy complete: ${INSTANCE_NAME:-${INSTANCE_ID_UPPER}} — health: ${HEALTH_STATE}"
echo "══════════════════════════════════════════════"
echo ""
echo "  Processes:"
pm2 list 2>/dev/null || echo "  (pm2 list failed)"
echo ""
echo "  Admin:  https://${ADMIN_DOMAIN}"
echo "  API:    https://${API_DOMAIN}"
echo ""
echo "  Logs:"
echo "    pm2 logs ${PM2_PREFIX}-api"
echo "    pm2 logs ${PM2_PREFIX}-bot"
echo "    Full deploy log: ${DEPLOY_LOG}"
echo ""

if [ "${HEALTH_STATE}" = "FAILED" ]; then
  exit 1
fi
