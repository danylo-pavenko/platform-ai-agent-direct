#!/usr/bin/env bash
#
# deploy.sh — Pull latest code, build, sync DB, restart PM2
#
# Run from project root as the app user (e.g. blessed):
#   bash infra/scripts/deploy.sh
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
cd "${PROJECT_ROOT}"

echo "══════════════════════════════════════"
echo "  Deploy — $(date '+%Y-%m-%d %H:%M:%S')"
echo "══════════════════════════════════════"

# ── Check .env exists ──
if [ ! -f .env ]; then
  echo "ERROR: .env not found. Copy .env.example and configure it."
  exit 1
fi

# Load env so DATABASE_URL is available
set -a; source .env; set +a

# ── 1. Pull latest ──
echo "[1/6] Pulling latest code..."
git pull --ff-only

# ── 2. Install dependencies ──
echo "[2/6] Installing dependencies..."
npm ci

# ── 3. Generate Prisma client ──
echo "[3/6] Generating Prisma client..."
cd apps/backend
npx prisma generate
cd "${PROJECT_ROOT}"

# ── 4. Sync DB schema ──
# prisma migrate deploy — applies pending SQL migrations from prisma/migrations/
# Falls back to prisma db push if no migrations directory exists yet.
echo "[4/6] Syncing database schema..."
cd apps/backend

MIGRATIONS_DIR="prisma/migrations"
if [ -d "${MIGRATIONS_DIR}" ] && [ -n "$(ls -A ${MIGRATIONS_DIR} 2>/dev/null)" ]; then
  echo "  Running prisma migrate deploy..."
  npx prisma migrate deploy || {
    echo ""
    echo "  ✗ migrate deploy failed — trying prisma db push as fallback..."
    _db_push_with_hint
  }
else
  echo "  No migrations found — running prisma db push..."
  npx prisma db push --accept-data-loss || {
    echo ""
    echo "  ✗ prisma db push failed."
    echo "  Likely cause: DB user lacks privileges."
    DB_USER=$(echo "${DATABASE_URL}" | sed -E 's|postgresql://([^:@]+).*|\1|')
    DB_NAME=$(echo "${DATABASE_URL}" | sed -E 's|.*/([^?]+).*|\1|')
    echo ""
    echo "  Fix (run as postgres superuser on this server):"
    echo "    sudo -u postgres psql ${DB_NAME} -c \\"
    echo "      \"GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO ${DB_USER};"
    echo "       GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO ${DB_USER};"
    echo "       ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO ${DB_USER};"
    echo "       ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO ${DB_USER};\""
    echo ""
    exit 1
  }
fi

cd "${PROJECT_ROOT}"

# ── 5. Build backend ──
echo "[5/6] Building backend..."
npm run build:backend

# ── 5b. Build admin ──
if [ -f apps/admin/vite.config.ts ] || [ -f apps/admin/vite.config.js ]; then
  echo "[5b/6] Building admin..."
  npm run build:admin
else
  echo "[5b/6] Skipping admin build (not found)"
fi

# ── 6. Restart PM2 ──
echo "[6/6] Restarting PM2..."
INSTANCE=$(grep '^INSTANCE_ID=' .env | cut -d= -f2 | tr '[:lower:]' '[:upper:]')
if pm2 list 2>/dev/null | grep -q "${INSTANCE}-api"; then
  pm2 reload ecosystem.config.cjs
else
  pm2 start ecosystem.config.cjs
fi
pm2 save

echo ""
echo "══════════════════════════════════════"
echo "  Deploy complete!"
echo "══════════════════════════════════════"
echo ""

# Quick health check
API_PORT=$(grep '^API_PORT=' .env | cut -d= -f2 || echo "3100")
sleep 2
if curl -sf "http://localhost:${API_PORT}/health" > /dev/null 2>&1; then
  echo "  ✓ Health check passed"
else
  echo "  ✗ Health check failed — check logs: pm2 logs ${INSTANCE}-api"
fi
echo ""
