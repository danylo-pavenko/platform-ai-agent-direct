#!/usr/bin/env bash
#
# dev.sh — Start all services locally for development
#
# Usage:
#   bash infra/scripts/dev.sh          # backend + frontend
#   bash infra/scripts/dev.sh --all    # + telegram bot
#
# Stop: Ctrl+C (kills all child processes)
#
set -eo pipefail

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
  if [ ${#PIDS[@]} -gt 0 ]; then
    for pid in "${PIDS[@]}"; do
      kill "$pid" 2>/dev/null || true
    done
  fi
  wait 2>/dev/null
  echo -e "${GREEN}All services stopped.${NC}"
}

trap cleanup EXIT INT TERM

# ── Check prerequisites ──
if [ ! -f .env ]; then
  echo -e "${RED}ERROR: .env not found. Copy .env.example and configure.${NC}"
  exit 1
fi

# Parse .env safely (handles values with spaces, quotes)
while IFS= read -r line; do
  # Skip comments and empty lines
  [[ -z "$line" || "$line" =~ ^# ]] && continue
  # Only export lines that look like KEY=VALUE
  if [[ "$line" =~ ^[A-Za-z_][A-Za-z0-9_]*= ]]; then
    export "${line?}"
  fi
done < .env

echo -e "${BLUE}══════════════════════════════════════${NC}"
echo -e "${BLUE}  Status Blessed — Dev Environment${NC}"
echo -e "${BLUE}══════════════════════════════════════${NC}"
echo ""

# ── Parse DB connection from DATABASE_URL ──
# Format: postgresql://user:pass@host:port/db
DB_HOST=$(echo "$DATABASE_URL" | sed -E 's|.*@([^:]+):.*|\1|')
DB_PORT=$(echo "$DATABASE_URL" | sed -E 's|.*:([0-9]+)/.*|\1|')
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
  (cd apps/backend && npx prisma generate)
fi

# ── Check if migrations are up to date ──
echo -n "Running Prisma migrations... "
(cd apps/backend && npx prisma migrate deploy 2>/dev/null)
echo -e "${GREEN}OK${NC}"

# ── Seed if needed ──
echo -n "Seeding database... "
(cd apps/backend && npx tsx src/prisma/seed.ts 2>/dev/null)
echo -e "${GREEN}OK${NC}"

echo ""

# ── Start Backend API ──
API_PORT="${API_PORT:-3100}"
echo -e "${GREEN}[1] Starting Backend API (port ${API_PORT})...${NC}"
(cd apps/backend && npx tsx src/server.ts) &
PIDS+=($!)
sleep 4

# Verify backend started
if curl -sf "http://localhost:${API_PORT}/health" > /dev/null 2>&1; then
  echo -e "    ${GREEN}✓ Backend running${NC}: http://localhost:${API_PORT}"
else
  echo -e "    ${RED}✗ Backend failed to start — check logs above${NC}"
  exit 1
fi

# ── Start Frontend Dev Server ──
ADMIN_PORT="${ADMIN_PORT:-3101}"
echo -e "${GREEN}[2] Starting Frontend (port ${ADMIN_PORT})...${NC}"
(cd apps/admin && npx vite --port "${ADMIN_PORT}") &
PIDS+=($!)
sleep 3
echo -e "    ${GREEN}✓ Frontend running${NC}: http://localhost:${ADMIN_PORT}"

# ── Optionally start Telegram bot ──
if [[ "${1:-}" == "--all" ]] && [ -n "${TELEGRAM_BOT_TOKEN:-}" ]; then
  echo -e "${GREEN}[3] Starting Telegram bot...${NC}"
  (cd apps/backend && npx tsx src/telegram-bot.ts) &
  PIDS+=($!)
  sleep 2
  echo -e "    ${GREEN}✓ Telegram bot running${NC}"
fi

echo ""
echo -e "${BLUE}══════════════════════════════════════${NC}"
echo -e "${BLUE}  All services running!${NC}"
echo -e "${BLUE}══════════════════════════════════════${NC}"
echo ""
echo -e "  Admin panel: ${GREEN}http://localhost:${ADMIN_PORT}${NC}"
echo -e "  Backend API: ${GREEN}http://localhost:${API_PORT}${NC}"
echo -e "  Health:      ${GREEN}http://localhost:${API_PORT}/health${NC}"
echo ""
echo -e "  Login: ${YELLOW}admin${NC} / ${YELLOW}${DEFAULT_ADMIN_PASSWORD:-SB-change-me-2026!}${NC}"
echo ""
echo -e "  Press ${RED}Ctrl+C${NC} to stop all services"
echo ""

# Wait for all children
wait
