#!/usr/bin/env bash
#
# deploy-super-admin.sh — Build and restart Super Admin app
#
# Run as agentsadmin from project root:
#   bash infra/scripts/deploy-super-admin.sh
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
cd "${PROJECT_ROOT}"

ENV_FILE=".env.super-admin"
APP_DIR="apps/super-admin"

echo "══════════════════════════════════════════"
echo "  Super Admin — Deploy"
echo "  $(date '+%Y-%m-%d %H:%M:%S')"
echo "══════════════════════════════════════════"

if [ ! -f "${ENV_FILE}" ]; then
  echo "ERROR: ${ENV_FILE} not found."
  echo "  Copy from provision or create manually."
  exit 1
fi

# Load env for health check
# shellcheck disable=SC2046
export $(grep -v '^#' "${ENV_FILE}" | grep -v '^$' | xargs)

# ── 1. Pull latest ──
echo "[1/5] Pulling latest..."
git pull --ff-only

# ── 2. Install super-admin deps ──
echo "[2/5] Installing dependencies..."
cd "${APP_DIR}"
npm ci --prefer-offline
cd "${PROJECT_ROOT}"

# ── 3. Generate Prisma client ──
echo "[3/5] Generating Prisma client..."
cd "${APP_DIR}"
DATABASE_URL="${DATABASE_URL}" npx prisma generate --schema=prisma/schema.prisma
cd "${PROJECT_ROOT}"

# ── 4. Build TypeScript ──
echo "[4/5] Building TypeScript..."
cd "${APP_DIR}"
npx tsc --project tsconfig.json
cd "${PROJECT_ROOT}"

# ── 5. Restart PM2 ──
echo "[5/5] Restarting PM2..."
if pm2 list 2>/dev/null | grep -q "SA-api"; then
  pm2 reload ecosystem.super-admin.config.cjs --update-env
else
  pm2 start ecosystem.super-admin.config.cjs
fi
pm2 save

# ── Health check ──
sleep 2
SA_PORT="${SA_API_PORT:-4000}"
STATUS=$(curl -s -o /dev/null -w "%{http_code}" "http://localhost:${SA_PORT}/api/health" 2>/dev/null || echo "000")
if [ "${STATUS}" = "200" ]; then
  echo "  ✓ Health check passed (HTTP ${STATUS})"
else
  echo "  ✗ Health check returned ${STATUS} — check: pm2 logs SA-api"
fi

echo ""
echo "══════════════════════════════════════════"
echo "  Done! https://admin.direct-ai-agents.com"
echo "══════════════════════════════════════════"
