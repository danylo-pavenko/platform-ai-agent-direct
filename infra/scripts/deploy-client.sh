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
# shellcheck disable=SC2046
export $(grep -v '^#' .env | grep -v '^$' | xargs)

INSTANCE_ID_UPPER="${INSTANCE_ID^^}"
API_PORT="${API_PORT:-3100}"
ADMIN_PORT="${ADMIN_PORT:-3101}"

echo "══════════════════════════════════════════════"
echo "  Deploy: ${INSTANCE_NAME:-${INSTANCE_ID_UPPER}}"
echo "  $(date '+%Y-%m-%d %H:%M:%S')"
echo "══════════════════════════════════════════════"

# ── 1. Pull latest ──
echo "[1/8] Pulling latest code..."
git pull --ff-only

# ── 2. Install dependencies ──
echo "[2/8] Installing dependencies..."
npm ci --prefer-offline

# ── 3. Generate Prisma client ──
echo "[3/8] Generating Prisma client..."
cd apps/backend
npx prisma generate
cd "${PROJECT_ROOT}"

# ── 4. Run migrations ──
echo "[4/8] Running database migrations..."
cd apps/backend
npx prisma migrate deploy
cd "${PROJECT_ROOT}"

# ── 5. Bootstrap tenant knowledge (seed missing files only) ──
echo "[5/8] Bootstrapping tenant knowledge..."
npm run bootstrap:knowledge

# ── 6. Build backend ──
echo "[6/8] Building backend..."
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

# ── 7. Build admin panel ──
if [ -f apps/admin/vite.config.ts ] || [ -f apps/admin/vite.config.js ]; then
  echo "[7/8] Building admin panel..."
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
  echo "[7/8] Admin panel not built yet — skipping"
fi

# ── 8. Restart PM2 ──
echo "[8/8] Restarting PM2 processes..."
PM2_PREFIX="${INSTANCE_ID_UPPER}"

# startOrReload handles both the first-time start and subsequent graceful
# reloads — avoids the race where `pm2 reload` runs before the process list
# has been initialised.
pm2 startOrReload ecosystem.config.cjs --update-env

# ── Health check ──
echo ""
echo "  Waiting for processes to come up..."

wait_for_port() {
  local port="$1"
  local label="$2"
  local attempts=30
  for ((i = 1; i <= attempts; i++)); do
    local status
    status=$(curl -s -o /dev/null -w "%{http_code}" "http://localhost:${port}/" 2>/dev/null || echo "000")
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
  HTTP_STATUS=$(curl -s -o /dev/null -w "%{http_code}" "http://localhost:${API_PORT}/health" 2>/dev/null || echo "000")
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
pm2 list 2>/dev/null | grep "${PM2_PREFIX}-" || echo "  (pm2 list failed)"
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
