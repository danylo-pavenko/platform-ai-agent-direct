#!/usr/bin/env bash
#
# Detached wrapper for Super Admin self-deploy from the web UI.
# Acquires an exclusive lock, runs deploy-super-admin.sh, then writes final
# status to job.json so the API process can die mid-deploy (PM2 restart)
# without losing the outcome.
#
# Portable: works on Linux (flock if present) and macOS bash 3.2 (mkdir lock).
#
# Env (required):
#   SA_SELF_DEPLOY_DIR   — e.g. /tmp/platform-sa-self-deploy
#   SA_SELF_DEPLOY_JOB_ID
#   SA_SELF_DEPLOY_SCRIPT — absolute path to deploy-super-admin.sh
#
set -u

DIR="${SA_SELF_DEPLOY_DIR:?SA_SELF_DEPLOY_DIR required}"
JOB_ID="${SA_SELF_DEPLOY_JOB_ID:?SA_SELF_DEPLOY_JOB_ID required}"
SCRIPT="${SA_SELF_DEPLOY_SCRIPT:?SA_SELF_DEPLOY_SCRIPT required}"
LOCK_FILE="${DIR}/deploy.lock"
LOCK_DIR="${DIR}/flock.lockdir"
JOB_JSON="${DIR}/job.json"
LOG="${DIR}/current.log"
START_GATE="${DIR}/starting.lockdir"

mkdir -p "${DIR}"
touch "${LOG}"

release_lock() {
  if command -v flock >/dev/null 2>&1 && [ -n "${FLOCK_FD:-}" ]; then
    # flock releases on FD close / process exit
    :
  fi
  rmdir "${LOCK_DIR}" 2>/dev/null || true
}

acquire_lock() {
  # Prefer util-linux flock when available (Linux servers).
  if command -v flock >/dev/null 2>&1; then
    exec 9>"${LOCK_FILE}"
    if flock -n 9; then
      FLOCK_FD=9
      return 0
    fi
    return 1
  fi
  # Fallback: atomic mkdir (macOS / busybox).
  if mkdir "${LOCK_DIR}" 2>/dev/null; then
    return 0
  fi
  return 1
}

if ! acquire_lock; then
  echo "[error] another Super Admin self-deploy holds the lock" >>"${LOG}"
  rm -rf "${START_GATE}" 2>/dev/null || true
  exit 1
fi

trap 'release_lock; rm -rf "${START_GATE}" 2>/dev/null || true' EXIT

write_job() {
  # Args via env — avoid bash 4 ${var@Q} (not on macOS bash 3.2).
  # SA_JOB_PID must be the bash wrapper ($$), not python's os.getpid() —
  # otherwise reconcileStale marks the job dead as soon as python exits.
  SA_JOB_STATUS="$1" \
  SA_JOB_EXIT="${2:-}" \
  SA_JOB_ERROR="${3:-}" \
  SA_JOB_FINISHED="${4:-}" \
  SA_JOB_JSON="${JOB_JSON}" \
  SA_JOB_ID="${JOB_ID}" \
  SA_JOB_LOG="${LOG}" \
  SA_JOB_PID="$$" \
  python3 - <<'PY'
import json, os
from datetime import datetime, timezone

path = os.environ["SA_JOB_JSON"]
job_id = os.environ["SA_JOB_ID"]
status = os.environ["SA_JOB_STATUS"]
exit_code = os.environ.get("SA_JOB_EXIT", "")
error = os.environ.get("SA_JOB_ERROR", "")
finished = os.environ.get("SA_JOB_FINISHED", "")
log_path = os.environ["SA_JOB_LOG"]
try:
    pid = int(os.environ.get("SA_JOB_PID") or "0") or None
except ValueError:
    pid = None

data = {
    "id": job_id,
    "status": status,
    "logPath": log_path,
    "pid": pid,
    "startedAt": None,
    "finishedAt": None,
    "exitCode": None,
    "error": None,
}
if os.path.isfile(path):
    try:
        data.update(json.load(open(path, encoding="utf-8")))
    except Exception:
        pass
data["id"] = job_id
data["status"] = status
data["logPath"] = log_path
# Prefer wrapper pid; keep Node-written pid if wrapper pid missing.
if pid is not None:
    data["pid"] = pid
if exit_code != "":
    try:
        data["exitCode"] = int(exit_code)
    except ValueError:
        data["exitCode"] = None
if error != "":
    data["error"] = error
elif status in ("succeeded", "failed"):
    data["error"] = data.get("error")
if not data.get("startedAt"):
    data["startedAt"] = datetime.now(timezone.utc).isoformat()
if finished == "1":
    data["finishedAt"] = datetime.now(timezone.utc).isoformat()
with open(path, "w", encoding="utf-8") as f:
    json.dump(data, f, indent=2)
    f.write("\n")
PY
}

echo "[self-deploy] job=${JOB_ID} pid=$$" >>"${LOG}"
echo "[self-deploy] script=${SCRIPT}" >>"${LOG}"
write_job "running" "" "" ""

if [ ! -f "${SCRIPT}" ]; then
  echo "[error] deploy script not found: ${SCRIPT}" >>"${LOG}"
  write_job "failed" "1" "deploy script not found" "1"
  exit 1
fi

set +e
bash "${SCRIPT}" >>"${LOG}" 2>&1
CODE=$?
set -e

if [ "${CODE}" -eq 0 ]; then
  echo "[self-deploy] finished: succeeded (exit 0)" >>"${LOG}"
  write_job "succeeded" "0" "" "1"
else
  echo "[self-deploy] finished: failed (exit ${CODE})" >>"${LOG}"
  write_job "failed" "${CODE}" "deploy-super-admin.sh exited ${CODE}" "1"
fi

exit "${CODE}"
