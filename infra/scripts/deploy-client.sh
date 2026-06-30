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
load_env_file() {
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
}
load_env_file

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

# npm ci can fail with ENOTEMPTY when node_modules is partially corrupted; one clean retry only.
npm_ci_with_enotempty_retry() {
  local _log
  _log="$(mktemp)"
  if npm ci --prefer-offline >"$_log" 2>&1; then
    rm -f "$_log"
    return 0
  fi
  if ! grep -qE 'ENOTEMPTY|directory not empty, rmdir' "$_log"; then
    cat "$_log" >&2
    rm -f "$_log"
    return 1
  fi
  echo "  WARN: npm ci failed (corrupt node_modules) — removing and retrying once..."
  cat "$_log" >&2
  rm -f "$_log"
  rm -rf node_modules apps/backend/node_modules apps/admin/node_modules apps/super-admin/node_modules
  npm ci --prefer-offline
}

echo "══════════════════════════════════════════════"
echo "  Deploy: ${INSTANCE_NAME:-${INSTANCE_ID_UPPER}}"
echo "  $(date '+%Y-%m-%d %H:%M:%S')"
echo "══════════════════════════════════════════════"

# ── 1. Pull latest ──
echo "[1/11] Pulling latest code..."
git pull --ff-only

# ── 2. Claude Code CLI (idempotent) ──
echo "[2/11] Ensuring Claude Code CLI..."
bash "${SCRIPT_DIR}/setup-claude-cli.sh"

# ── 3. Install dependencies ──
echo "[3/11] Installing dependencies..."
npm_ci_with_enotempty_retry

# ── 3b. faster-whisper STT (idempotent) ──
echo "[4/11] Setting up faster-whisper STT (idempotent)..."
if [ "${STT_ENABLED:-true}" = "true" ]; then
  bash "${SCRIPT_DIR}/setup-whisper.sh"
  load_env_file
else
  echo "  STT_ENABLED=false — skipping whisper setup"
fi

# ── 4. Generate Prisma client ──
echo "[5/11] Generating Prisma client..."
cd apps/backend
npx prisma generate
cd "${PROJECT_ROOT}"

# ── 5. Run migrations ──
echo "[6/11] Running database migrations..."
cd apps/backend
npx prisma migrate deploy
cd "${PROJECT_ROOT}"

# ── 6. Seed admin user + default settings ──
echo "[7/11] Seeding admin user and default settings..."
cd apps/backend
npx prisma db seed
cd "${PROJECT_ROOT}"

# ── 7. Bootstrap tenant knowledge (seed missing files only) ──
echo "[8/11] Bootstrapping tenant knowledge..."
npm run bootstrap:knowledge

# ── 8. Build backend ──
echo "[9/11] Building backend..."
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

echo "[9b/11] Running backend unit tests..."
if ! npm run test:backend >>"${DEPLOY_LOG}" 2>&1; then
  echo "  Unit tests failed — see ${DEPLOY_LOG}" >&2
  tail -40 "${DEPLOY_LOG}" >&2
  exit 1
fi

# ── 8. Build admin panel ──
if [ -f apps/admin/vite.config.ts ] || [ -f apps/admin/vite.config.js ]; then
  echo "[10/11] Building admin panel..."
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
  echo "[10/11] Admin panel not built yet — skipping"
fi

# ── 9b. Whisper port sanity (multi-tenant VPS) ──
if [ "${STT_ENABLED:-true}" = "true" ]; then
  RECOMMENDED_WHISPER_PORT=$((API_PORT + 5000))
  WHISPER_PORT="${WHISPER_SERVICE_PORT:-8100}"
  if [ "${WHISPER_PORT}" != "${RECOMMENDED_WHISPER_PORT}" ]; then
    echo "  WARN: WHISPER_SERVICE_PORT=${WHISPER_PORT} — on shared VPS use API_PORT+5000=${RECOMMENDED_WHISPER_PORT}" >&2
    echo "        (SB on :8100, TKP on :8200, etc. — one whisper port per tenant)" >&2
  fi
fi

# ── 11. Restart PM2 ──
echo "[11/11] Restarting PM2 processes..."
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
WHISPER_OK=1

# Whisper STT health (when enabled)
if [ "${STT_ENABLED:-true}" = "true" ]; then
  WHISPER_PORT="${WHISPER_SERVICE_PORT:-8100}"
  WHISPER_OK=0
  for ((i = 1; i <= 45; i++)); do
    WHISPER_STATUS=$(curl -s -o /dev/null -w "%{http_code}" --max-time 2 "http://127.0.0.1:${WHISPER_PORT}/health" 2>/dev/null || printf '000')
    WHISPER_STATUS="${WHISPER_STATUS:0:3}"
    if [ "${WHISPER_STATUS}" = "200" ]; then
      echo "  Whisper /health OK on :${WHISPER_PORT} (HTTP 200)"
      WHISPER_OK=1
      break
    fi
    sleep 2
  done
  if [ "${WHISPER_OK}" = "0" ]; then
    echo "  WARN: Whisper STT did not respond on :${WHISPER_PORT} (voice notes may fail)" >&2
    if command -v ss >/dev/null 2>&1 && ss -tlnH "sport = :${WHISPER_PORT}" 2>/dev/null | grep -q .; then
      echo "  Port :${WHISPER_PORT} already in use — likely another tenant's whisper (EADDRINUSE)." >&2
      ss -tlnpH "sport = :${WHISPER_PORT}" 2>&1 || true
      echo "  Fix in .env: WHISPER_SERVICE_PORT=\$((API_PORT + 5000)) and matching WHISPER_SERVICE_URL" >&2
    fi
    pm2 logs "${PM2_PREFIX}-whisper" --lines 15 --nostream 2>&1 || true
  fi
fi

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
  if pm2 describe "${PM2_PREFIX}-bot" > /dev/null 2>&1; then
    BOT_STATUS=$(pm2 jlist 2>/dev/null | node -e "
      const apps = JSON.parse(require('fs').readFileSync(0,'utf8'));
      const bot = apps.find(a => a.name === '${PM2_PREFIX}-bot');
      process.stdout.write(bot?.pm2_env?.status || 'missing');
    " 2>/dev/null || echo "unknown")
    if [ "${BOT_STATUS}" = "online" ] || [ "${BOT_STATUS}" = "launching" ]; then
      echo "  Bot PM2: ${BOT_STATUS} (idle until Telegram token is saved in admin)"
    else
      echo "  WARN: Bot PM2 status is ${BOT_STATUS} (expected online)" >&2
    fi
  else
    echo "  WARN: ${PM2_PREFIX}-bot process not found in PM2" >&2
  fi
fi

if [ "${API_OK}" = "1" ] && [ "${ADMIN_OK}" = "1" ] && [ "${WHISPER_OK}" = "1" ]; then
  pm2 save
  HEALTH_STATE="OK"
elif [ "${API_OK}" = "1" ] && [ "${ADMIN_OK}" = "1" ]; then
  pm2 save
  HEALTH_STATE="OK (Whisper STT degraded)"
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
echo "    pm2 logs ${PM2_PREFIX}-whisper"
echo "    Full deploy log: ${DEPLOY_LOG}"
echo ""

if [ "${HEALTH_STATE}" = "FAILED" ]; then
  exit 1
fi
