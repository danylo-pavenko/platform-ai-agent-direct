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

# ── Load env ──
if [ ! -f .env ]; then
  echo "ERROR: .env not found in ${PROJECT_ROOT}. Configure it first."
  exit 1
fi
# shellcheck disable=SC2046
export $(grep -v '^#' .env | grep -v '^$' | xargs)

INSTANCE_ID_UPPER="${INSTANCE_ID^^}"

echo "══════════════════════════════════════════════"
echo "  Deploy: ${INSTANCE_NAME:-${INSTANCE_ID_UPPER}}"
echo "  $(date '+%Y-%m-%d %H:%M:%S')"
echo "══════════════════════════════════════════════"

# ── 1. Pull latest ──
echo "[1/7] Pulling latest code..."
git pull --ff-only

# ── 2. Install dependencies ──
echo "[2/7] Installing dependencies..."
npm ci --prefer-offline

# ── 3. Generate Prisma client ──
echo "[3/7] Generating Prisma client..."
cd apps/backend
npx prisma generate
cd "${PROJECT_ROOT}"

# ── 4. Run migrations ──
echo "[4/7] Running database migrations..."
cd apps/backend
npx prisma migrate deploy
cd "${PROJECT_ROOT}"

# ── 4b. Migrate super-admin DB (if present in this repo) ──
if [ -f apps/super-admin/prisma/schema.prisma ]; then
  echo "[4b/7] Migrating super-admin DB..."
  cd apps/super-admin
  npx prisma migrate deploy --schema=prisma/schema.prisma 2>/dev/null || \
    npx prisma db push --schema=prisma/schema.prisma --accept-data-loss
  cd "${PROJECT_ROOT}"
fi

# ── 5. Build backend ──
echo "[5/7] Building backend..."
npm run build:backend 2>&1 | tail -5

# ── 6. Build admin panel ──
if [ -f apps/admin/vite.config.ts ] || [ -f apps/admin/vite.config.js ]; then
  echo "[6/7] Building admin panel..."
  npm run build:admin 2>&1 | tail -5
else
  echo "[6/7] Admin panel not built yet — skipping"
fi

# ── 7. Restart PM2 ──
echo "[7/7] Restarting PM2 processes..."
PM2_PREFIX="${INSTANCE_ID_UPPER}"

if pm2 list 2>/dev/null | grep -q "${PM2_PREFIX}-api"; then
  echo "  Reloading existing processes..."
  pm2 reload ecosystem.config.cjs --update-env
else
  echo "  Starting new processes..."
  INSTANCE_ID="${INSTANCE_ID}" pm2 start ecosystem.config.cjs
fi

pm2 save

# ── Health check ──
echo ""
echo "  Health check (localhost:${API_PORT}/health)..."
sleep 3
HTTP_STATUS=$(curl -s -o /dev/null -w "%{http_code}" "http://localhost:${API_PORT}/health" 2>/dev/null || echo "000")
if [ "${HTTP_STATUS}" = "200" ]; then
  echo "  Health check passed (HTTP ${HTTP_STATUS})"
else
  echo "  Health check returned HTTP ${HTTP_STATUS} — check logs: pm2 logs ${PM2_PREFIX}-api"
fi

echo ""
echo "══════════════════════════════════════════════"
echo "  Deploy complete: ${INSTANCE_NAME:-${INSTANCE_ID_UPPER}}"
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
echo ""
