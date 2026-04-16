#!/usr/bin/env bash
#
# dev.sh — Start all services locally for development
#
# Usage:
#   bash infra/scripts/dev.sh          # backend + frontend
#   bash infra/scripts/dev.sh --all    # + telegram bot
#
# Prerequisites:
#   - PostgreSQL running (port 5432 or 5433)
#   - .env configured
#   - npm install done
#   - prisma migrate + seed done
#
# Stop: Ctrl+C (kills all child processes)
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
cd "${PROJECT_ROOT}"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

# Track child PIDs for cleanup
PIDS=()

cleanup() {
  echo ""
  echo -e "${YELLOW}Shutting down...${NC}"
  for pid in "${PIDS[@]}"; do
    kill "$pid" 2>/dev/null || true
  done
  wait 2>/dev/null
  echo -e "${GREEN}All services stopped.${NC}"
}

trap cleanup EXIT INT TERM

# ── Check prerequisites ──
if [ ! -f .env ]; then
  echo -e "${RED}ERROR: .env not found. Copy .env.example and configure.${NC}"
  exit 1
fi

# Source .env for DB check
set -a
source .env
set +a

echo -e "${BLUE}══════════════════════════════════════${NC}"
echo -e "${BLUE}  Status Blessed — Dev Environment${NC}"
echo -e "${BLUE}══════════════════════════════════════${NC}"
echo ""

# ── Check DB connection ──
DB_PORT=$(echo "$DATABASE_URL" | grep -oP '(?<=:)\d+(?=/)')
DB_HOST=$(echo "$DATABASE_URL" | grep -oP '(?<=@)[^:]+')
echo -n "Checking PostgreSQL ($DB_HOST:$DB_PORT)... "
if pg_isready -h "$DB_HOST" -p "$DB_PORT" -q 2>/dev/null; then
  echo -e "${GREEN}OK${NC}"
else
  echo -e "${RED}FAILED${NC}"
  echo "  Start PostgreSQL: brew services start postgresql@18"
  exit 1
fi

# ── Check if Prisma client is generated ──
if [ ! -d "apps/backend/src/generated/prisma" ]; then
  echo -e "${YELLOW}Generating Prisma client...${NC}"
  cd apps/backend && npx prisma generate && cd "$PROJECT_ROOT"
fi

# ── Check if migrations are up to date ──
echo -n "Running Prisma migrations... "
cd apps/backend && npx prisma migrate deploy --schema=src/prisma/schema.prisma 2>/dev/null && cd "$PROJECT_ROOT"
echo -e "${GREEN}OK${NC}"

# ── Seed if needed ──
echo -n "Seeding database... "
cd apps/backend && npx tsx src/prisma/seed.ts 2>/dev/null && cd "$PROJECT_ROOT"
echo -e "${GREEN}OK${NC}"

echo ""

# ── Start Backend API ──
echo -e "${GREEN}[1] Starting Backend API (port ${API_PORT:-3100})...${NC}"
cd apps/backend && npx tsx src/server.ts &
PIDS+=($!)
cd "$PROJECT_ROOT"
sleep 3

# Verify backend started
if curl -sf "http://localhost:${API_PORT:-3100}/health" > /dev/null 2>&1; then
  echo -e "    ${GREEN}✓ Backend running${NC}: http://localhost:${API_PORT:-3100}"
else
  echo -e "    ${RED}✗ Backend failed to start${NC}"
  exit 1
fi

# ── Start Frontend Dev Server ──
echo -e "${GREEN}[2] Starting Frontend (port ${ADMIN_PORT:-3101})...${NC}"
cd apps/admin && npx vite --port "${ADMIN_PORT:-3101}" &
PIDS+=($!)
cd "$PROJECT_ROOT"
sleep 3
echo -e "    ${GREEN}✓ Frontend running${NC}: http://localhost:${ADMIN_PORT:-3101}"

# ── Optionally start Telegram bot ──
if [[ "${1:-}" == "--all" ]] && [ -n "${TELEGRAM_BOT_TOKEN:-}" ]; then
  echo -e "${GREEN}[3] Starting Telegram bot...${NC}"
  cd apps/backend && npx tsx src/telegram-bot.ts &
  PIDS+=($!)
  cd "$PROJECT_ROOT"
  sleep 2
  echo -e "    ${GREEN}✓ Telegram bot running${NC}"
fi

echo ""
echo -e "${BLUE}══════════════════════════════════════${NC}"
echo -e "${BLUE}  All services running!${NC}"
echo -e "${BLUE}══════════════════════════════════════${NC}"
echo ""
echo -e "  Admin panel: ${GREEN}http://localhost:${ADMIN_PORT:-3101}${NC}"
echo -e "  Backend API: ${GREEN}http://localhost:${API_PORT:-3100}${NC}"
echo -e "  Health:      ${GREEN}http://localhost:${API_PORT:-3100}/health${NC}"
echo ""
echo -e "  Login: ${YELLOW}admin${NC} / ${YELLOW}${DEFAULT_ADMIN_PASSWORD:-SB-change-me-2026!}${NC}"
echo ""
echo -e "  Press ${RED}Ctrl+C${NC} to stop all services"
echo ""

# Wait for all children
wait
