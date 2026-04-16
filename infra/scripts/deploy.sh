#!/usr/bin/env bash
#
# deploy.sh — Pull latest code, build, migrate, restart PM2
#
# Run from project root as the app user (sbagent):
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

# ── Pull latest ──
echo "[1/6] Pulling latest code..."
git pull --ff-only

# ── Install dependencies ──
echo "[2/6] Installing dependencies..."
npm ci

# ── Generate Prisma client ──
echo "[3/6] Generating Prisma client..."
cd apps/backend
npx prisma generate
cd "${PROJECT_ROOT}"

# ── Run migrations ──
echo "[4/6] Running database migrations..."
cd apps/backend
npx prisma migrate deploy
cd "${PROJECT_ROOT}"

# ── Build backend ──
echo "[5/6] Building backend..."
npm run build:backend

# ── Build admin (if src exists) ──
if [ -f apps/admin/vite.config.ts ] || [ -f apps/admin/vite.config.js ]; then
  echo "[5.5/6] Building admin..."
  npm run build:admin
else
  echo "[5.5/6] Skipping admin build (not set up yet)"
fi

# ── Restart PM2 ──
echo "[6/6] Restarting PM2 processes..."
if pm2 list 2>/dev/null | grep -q "$(grep INSTANCE_ID .env | cut -d= -f2 | tr '[:lower:]' '[:upper:]')-api"; then
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
API_PORT=$(grep API_PORT .env | cut -d= -f2)
sleep 2
if curl -sf "http://localhost:${API_PORT}/health" > /dev/null 2>&1; then
  echo "  ✓ Health check passed"
else
  echo "  ⚠ Health check failed — check logs: pm2 logs"
fi
echo ""
