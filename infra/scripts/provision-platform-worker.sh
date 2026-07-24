#!/usr/bin/env bash
# provision-platform-worker.sh — Install Super Admin companion (platform-worker) on a worker VPS.
# Run as root after provision-server.sh.
#
#   WORKER_SHARED_SECRET=... PUBLIC_IP=1.2.3.4 bash infra/scripts/provision-platform-worker.sh
#
set -euo pipefail

if [[ "$(id -u)" -ne 0 ]]; then
  echo "ERROR: Run as root → sudo bash provision-platform-worker.sh"
  exit 1
fi

LINUX_USER="${LINUX_USER:-agentsadmin}"
APP_DIR="${APP_DIR:-/home/${LINUX_USER}/platform-ai-agent-direct}"
PLATFORM_REPO="${PLATFORM_REPO:-git@github.com:danylo-pavenko/platform-ai-agent-direct.git}"
WORKER_PORT="${WORKER_PORT:-4100}"
WORKER_SHARED_SECRET="${WORKER_SHARED_SECRET:-}"
PUBLIC_IP="${PUBLIC_IP:-}"

if [[ -z "${WORKER_SHARED_SECRET}" || ${#WORKER_SHARED_SECRET} -lt 32 ]]; then
  echo "ERROR: Set WORKER_SHARED_SECRET to a random string (≥32 chars)."
  echo "  Generate: openssl rand -hex 32"
  exit 1
fi

if ! id -u "${LINUX_USER}" >/dev/null 2>&1; then
  echo "ERROR: User ${LINUX_USER} missing. Run provision-server / create agentsadmin first."
  exit 1
fi

echo "==> Ensuring repo at ${APP_DIR}"
if [[ ! -d "${APP_DIR}/.git" ]]; then
  sudo -u "${LINUX_USER}" git clone "${PLATFORM_REPO}" "${APP_DIR}"
else
  sudo -u "${LINUX_USER}" git -C "${APP_DIR}" pull --ff-only || true
fi

ENV_FILE="${APP_DIR}/apps/platform-worker/.env"
echo "==> Writing ${ENV_FILE}"
cat > "${ENV_FILE}" <<EOF
NODE_ENV=production
WORKER_PORT=${WORKER_PORT}
WORKER_HOST=0.0.0.0
WORKER_SHARED_SECRET=${WORKER_SHARED_SECRET}
PLATFORM_REPO_ROOT=${APP_DIR}
LOG_LEVEL=info
EOF
chown "${LINUX_USER}:${LINUX_USER}" "${ENV_FILE}"
chmod 600 "${ENV_FILE}"

echo "==> npm ci + build platform-worker"
sudo -u "${LINUX_USER}" bash -lc "
  set -euo pipefail
  cd '${APP_DIR}'
  npm ci --workspace=apps/platform-worker --include-workspace-root=false 2>/dev/null \
    || (cd apps/platform-worker && npm install)
  cd apps/platform-worker && npm run build
"

echo "==> PM2 PW-api"
sudo -u "${LINUX_USER}" bash -lc "
  set -euo pipefail
  cd '${APP_DIR}/apps/platform-worker'
  pm2 delete PW-api 2>/dev/null || true
  pm2 start dist/server.js --name PW-api --time
  pm2 save
"

if [[ -n "${PUBLIC_IP}" ]]; then
  echo ""
  echo "Add this worker in Super Admin → Workers:"
  echo "  name:     (choose slug, e.g. eu-2)"
  echo "  baseUrl:  http://${PUBLIC_IP}:${WORKER_PORT}   # prefer HTTPS + firewall allowlist"
  echo "  publicIp: ${PUBLIC_IP}"
  echo "  secret:   (same WORKER_SHARED_SECRET)"
fi

echo ""
echo "Done. Test: curl -H \"Authorization: Bearer \$WORKER_SHARED_SECRET\" http://127.0.0.1:${WORKER_PORT}/health"
