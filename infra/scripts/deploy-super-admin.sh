#!/usr/bin/env bash
#
# deploy-super-admin.sh — Build and restart Super Admin app
#
# Run as agentsadmin from anywhere:
#   bash infra/scripts/deploy-super-admin.sh
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
APP_DIR="${PROJECT_ROOT}/apps/super-admin"
ENV_FILE="${PROJECT_ROOT}/.env.super-admin"

cd "${PROJECT_ROOT}"

echo "══════════════════════════════════════════"
echo "  Super Admin — Deploy"
echo "  $(date '+%Y-%m-%d %H:%M:%S')"
echo "══════════════════════════════════════════"

if [ ! -f "${ENV_FILE}" ]; then
  echo "ERROR: ${ENV_FILE} not found."
  exit 1
fi

# Load env
set -a; source "${ENV_FILE}"; set +a

# ── 1. Pull latest ──
echo "[1/6] Pulling latest..."
git pull --ff-only

# ── 2. Install deps (include dev — потрібен tsc для build) ──
echo "[2/6] Installing dependencies..."
NODE_ENV=development npm install --prefix "${APP_DIR}"

# ── 3. Generate Prisma client ──
echo "[3/6] Generating Prisma client..."
cd "${APP_DIR}"
DATABASE_URL="${DATABASE_URL}" npx prisma generate --schema=prisma/schema.prisma

# ── 3b. Sync DB schema (db push = apply schema without migration history) ──
# Uses --accept-data-loss because we manage schema via Prisma only (no manual ALTER).
# Safe on a fresh or already-in-sync DB. Idempotent.
echo "[3b/6] Syncing database schema (prisma db push)..."
DATABASE_URL="${DATABASE_URL}" npx prisma db push --schema=prisma/schema.prisma --accept-data-loss || {
  echo ""
  echo "  ✗ prisma db push failed."
  echo "  Likely cause: DB user lacks privileges on the schema."
  echo "  Fix (run as postgres superuser):"
  echo ""
  # Extract user from DATABASE_URL: postgresql://USER:pass@host/db
  DB_USER=$(echo "${DATABASE_URL}" | sed -E 's|postgresql://([^:@]+).*|\1|')
  DB_NAME=$(echo "${DATABASE_URL}" | sed -E 's|.*/([^?]+).*|\1|')
  echo "    sudo -u postgres psql ${DB_NAME} -c \\"
  echo "      \"GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO ${DB_USER};"
  echo "       GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO ${DB_USER};"
  echo "       ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO ${DB_USER};"
  echo "       ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO ${DB_USER};\""
  echo ""
  echo "  Then re-run: bash infra/scripts/deploy-super-admin.sh"
  exit 1
}

cd "${PROJECT_ROOT}"

# ── 4. Build TypeScript ──
echo "[4/6] Building TypeScript..."
cd "${APP_DIR}"
./node_modules/.bin/tsc --project tsconfig.json
cd "${PROJECT_ROOT}"

# ── 5. Restart PM2 (inject env vars from .env.super-admin) ──
echo "[5/6] Restarting PM2..."

if pm2 list 2>/dev/null | grep -q "SA-api"; then
  pm2 stop SA-api 2>/dev/null || true
  pm2 delete SA-api 2>/dev/null || true
fi

# Start with environment loaded from file
env $(grep -v '^#' "${ENV_FILE}" | grep -v '^$' | xargs) \
  pm2 start ecosystem.super-admin.config.cjs

pm2 save

# ── 6. Health check ──
echo "[6/6] Health check..."
sleep 2
SA_PORT="${SA_API_PORT:-4000}"
STATUS=$(curl -s -o /dev/null -w "%{http_code}" "http://localhost:${SA_PORT}/api/health" 2>/dev/null || echo "000")
if [ "${STATUS}" = "200" ]; then
  echo "  ✓ Health OK (HTTP ${STATUS})"
else
  echo "  ✗ HTTP ${STATUS} — check: pm2 logs SA-api"
fi

echo ""
echo "══════════════════════════════════════════"
echo "  Done! https://admin.direct-ai-agents.com"
echo "══════════════════════════════════════════"
