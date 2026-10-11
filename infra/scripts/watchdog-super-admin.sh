#!/usr/bin/env bash
#
# watchdog-super-admin.sh — If Super Admin /api/health is down, run deploy-super-admin.sh.
#
# Intended for cron every 15 minutes (see install-sa-watchdog-cron.sh).
# Skips when a UI self-deploy or another watchdog/deploy already holds the lock.
#
# Run as agentsadmin:
#   bash infra/scripts/watchdog-super-admin.sh
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
ENV_FILE="${PROJECT_ROOT}/.env.super-admin"
DEPLOY_SCRIPT="${SCRIPT_DIR}/deploy-super-admin.sh"
SELF_DEPLOY_DIR="${SA_SELF_DEPLOY_DIR:-/tmp/platform-sa-self-deploy}"
WATCHDOG_LOCK_DIR="${SELF_DEPLOY_DIR}/watchdog.lockdir"
LOG_TAG="[sa-watchdog]"

ts() { date '+%Y-%m-%d %H:%M:%S'; }
log() { echo "$(ts) ${LOG_TAG} $*"; }

# Cron often has a minimal PATH. Pull user profile bins when present.
if [ -d "${HOME}/.nvm/versions/node" ]; then
  # Newest installed nvm node (lexical sort works for v24.x layout).
  _nvm_latest="$(ls -1 "${HOME}/.nvm/versions/node" 2>/dev/null | sort -V | tail -1 || true)"
  if [ -n "${_nvm_latest}" ] && [ -d "${HOME}/.nvm/versions/node/${_nvm_latest}/bin" ]; then
    export PATH="${HOME}/.nvm/versions/node/${_nvm_latest}/bin:${PATH}"
  fi
fi
export PATH="/usr/local/bin:/usr/bin:/bin:${HOME}/.local/bin:${PATH}"

if [ ! -f "${ENV_FILE}" ]; then
  log "ERROR: ${ENV_FILE} not found — abort"
  exit 1
fi
if [ ! -f "${DEPLOY_SCRIPT}" ]; then
  log "ERROR: ${DEPLOY_SCRIPT} not found — abort"
  exit 1
fi

set -a
# shellcheck disable=SC1090
source "${ENV_FILE}"
set +a

SA_PORT="${SA_API_PORT:-4000}"
HEALTH_URL="http://127.0.0.1:${SA_PORT}/api/health"

health_ok() {
  local code
  code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "${HEALTH_URL}" 2>/dev/null || echo 000)"
  [ "${code}" = "200" ]
}

self_deploy_busy() {
  [ -d "${SELF_DEPLOY_DIR}/starting.lockdir" ] || [ -d "${SELF_DEPLOY_DIR}/flock.lockdir" ]
}

pm2_sa_status() {
  if ! command -v pm2 >/dev/null 2>&1; then
    echo "pm2-missing"
    return
  fi
  pm2 jlist 2>/dev/null | node -e '
    let d=""; process.stdin.on("data",c=>d+=c); process.stdin.on("end",()=>{
      try {
        const apps=JSON.parse(d||"[]");
        const sa=apps.find(a=>a.name==="SA-api");
        process.stdout.write(sa?.pm2_env?.status || "missing");
      } catch { process.stdout.write("unknown"); }
    });
  ' 2>/dev/null || echo "unknown"
}

if health_ok; then
  log "OK health ${HEALTH_URL} (pm2=$(pm2_sa_status))"
  exit 0
fi

log "WARN health failed on ${HEALTH_URL} (pm2=$(pm2_sa_status)) — recheck in 20s"
sleep 20

if health_ok; then
  log "OK health recovered after wait (transient blip)"
  exit 0
fi

if self_deploy_busy; then
  log "SKIP deploy — UI self-deploy lock present under ${SELF_DEPLOY_DIR}"
  exit 0
fi

# Exclusive watchdog gate (mkdir). Avoid two crons overlapping a long deploy.
mkdir -p "${SELF_DEPLOY_DIR}"
if ! mkdir "${WATCHDOG_LOCK_DIR}" 2>/dev/null; then
  log "SKIP deploy — another watchdog already running"
  exit 0
fi
cleanup_watchdog_lock() { rmdir "${WATCHDOG_LOCK_DIR}" 2>/dev/null || true; }
trap cleanup_watchdog_lock EXIT

# Re-check after taking lock (race with UI self-deploy).
if self_deploy_busy; then
  log "SKIP deploy — self-deploy started while acquiring watchdog lock"
  exit 0
fi
if health_ok; then
  log "OK health recovered before deploy"
  exit 0
fi

log "RECOVER starting deploy-super-admin.sh (pm2 was $(pm2_sa_status))"
cd "${PROJECT_ROOT}"
set +e
bash "${DEPLOY_SCRIPT}"
CODE=$?
set -e

if health_ok; then
  log "RECOVER succeeded (exit=${CODE}) health OK"
  exit 0
fi

log "RECOVER FAILED exit=${CODE} health still down (pm2=$(pm2_sa_status)) — check pm2 logs SA-api"
exit 1
