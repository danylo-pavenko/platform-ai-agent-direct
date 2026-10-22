#!/usr/bin/env bash
#
# restore-tenant-db.sh — Download an S3 dump and restore into the tenant DB.
# Always uploads a pre_restore safety dump first.
#
# Required env:
#   INSTANCE_ID APP_DIR STORAGE_KEY
#   S3_ENDPOINT S3_BUCKET AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY
# Optional: S3_REGION S3_FORCE_PATH_STYLE CONFIRM_INSTANCE_ID (must equal INSTANCE_ID)
#
set -euo pipefail

INSTANCE_ID="${INSTANCE_ID:?INSTANCE_ID required}"
APP_DIR="${APP_DIR:?APP_DIR required}"
STORAGE_KEY="${STORAGE_KEY:?STORAGE_KEY required}"
S3_ENDPOINT="${S3_ENDPOINT:?S3_ENDPOINT required}"
S3_BUCKET="${S3_BUCKET:?S3_BUCKET required}"
AWS_ACCESS_KEY_ID="${AWS_ACCESS_KEY_ID:?AWS_ACCESS_KEY_ID required}"
AWS_SECRET_ACCESS_KEY="${AWS_SECRET_ACCESS_KEY:?AWS_SECRET_ACCESS_KEY required}"
S3_REGION="${S3_REGION:-us-east-1}"
S3_FORCE_PATH_STYLE="${S3_FORCE_PATH_STYLE:-true}"
export AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_DEFAULT_REGION="${S3_REGION}"

CONFIRM_INSTANCE_ID="${CONFIRM_INSTANCE_ID:-}"
if [ -n "${CONFIRM_INSTANCE_ID}" ] && [ "${CONFIRM_INSTANCE_ID}" != "${INSTANCE_ID}" ]; then
  echo "ERROR: CONFIRM_INSTANCE_ID mismatch (got '${CONFIRM_INSTANCE_ID}', expected '${INSTANCE_ID}')" >&2
  exit 1
fi

ENV_FILE="${APP_DIR}/.env"
if [ ! -f "${ENV_FILE}" ]; then
  echo "ERROR: ${ENV_FILE} not found" >&2
  exit 1
fi
DATABASE_URL="$(grep -E '^DATABASE_URL=' "${ENV_FILE}" | head -1 | cut -d= -f2- | sed -e 's/^"//' -e 's/"$//' -e "s/^'//" -e "s/'$//")"
export DATABASE_URL
if [ -z "${DATABASE_URL}" ]; then
  echo "ERROR: DATABASE_URL empty in ${ENV_FILE}" >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Prefer sibling backup script from the same tree (platform repo or tenant copy).
BACKUP_SCRIPT="${SCRIPT_DIR}/backup-tenant-db.sh"
if [ ! -f "${BACKUP_SCRIPT}" ]; then
  BACKUP_SCRIPT="${APP_DIR}/infra/scripts/backup-tenant-db.sh"
fi

echo "[restore] safety dump (pre_restore) before overwrite..."
BACKUP_SOURCE=pre_restore \
INSTANCE_ID="${INSTANCE_ID}" \
APP_DIR="${APP_DIR}" \
DATABASE_URL="${DATABASE_URL}" \
S3_ENDPOINT="${S3_ENDPOINT}" \
S3_BUCKET="${S3_BUCKET}" \
S3_REGION="${S3_REGION}" \
S3_FORCE_PATH_STYLE="${S3_FORCE_PATH_STYLE}" \
AWS_ACCESS_KEY_ID="${AWS_ACCESS_KEY_ID}" \
AWS_SECRET_ACCESS_KEY="${AWS_SECRET_ACCESS_KEY}" \
bash "${BACKUP_SCRIPT}"

TMP_DIR="$(mktemp -d /tmp/sa-restore-XXXXXX)"
DUMP_FILE="${TMP_DIR}/restore.dump"
cleanup() { rm -rf "${TMP_DIR}"; }
trap cleanup EXIT

echo "[restore] downloading s3://${S3_BUCKET}/${STORAGE_KEY}"
if command -v aws >/dev/null 2>&1; then
  export AWS_S3_ADDRESSING_STYLE=path
  aws s3 cp "s3://${S3_BUCKET}/${STORAGE_KEY}" "${DUMP_FILE}" --endpoint-url "${S3_ENDPOINT}"
elif command -v mc >/dev/null 2>&1; then
  alias_name="sarestore$$"
  mc alias set "${alias_name}" "${S3_ENDPOINT}" "${AWS_ACCESS_KEY_ID}" "${AWS_SECRET_ACCESS_KEY}" >/dev/null
  mc cp "${alias_name}/${S3_BUCKET}/${STORAGE_KEY}" "${DUMP_FILE}"
  mc alias remove "${alias_name}" >/dev/null 2>&1 || true
else
  echo "ERROR: neither aws nor mc found" >&2
  exit 1
fi

INSTANCE_ID_UPPER="${INSTANCE_ID^^}"
echo "[restore] stopping PM2 apps ${INSTANCE_ID_UPPER}-* (best-effort)..."
if command -v pm2 >/dev/null 2>&1; then
  # Prefer the tenant user's PM2 if we can detect linux user from APP_DIR /home/<user>/...
  LINUX_USER="$(echo "${APP_DIR}" | sed -n 's|^/home/\([^/]*\)/.*|\1|p')"
  if [ -n "${LINUX_USER}" ] && id "${LINUX_USER}" >/dev/null 2>&1; then
    sudo -u "${LINUX_USER}" bash -lc "pm2 stop ${INSTANCE_ID_UPPER}-api ${INSTANCE_ID_UPPER}-bot ${INSTANCE_ID_UPPER}-sync ${INSTANCE_ID_UPPER}-admin ${INSTANCE_ID_UPPER}-whisper 2>/dev/null || true" || true
  else
    pm2 stop "${INSTANCE_ID_UPPER}-api" "${INSTANCE_ID_UPPER}-bot" "${INSTANCE_ID_UPPER}-sync" "${INSTANCE_ID_UPPER}-admin" 2>/dev/null || true
  fi
fi

echo "[restore] pg_restore --clean --if-exists into tenant database..."
# --clean drops objects before recreate; --if-exists avoids errors on missing objects.
pg_restore --no-owner --no-acl --clean --if-exists -d "${DATABASE_URL}" "${DUMP_FILE}" \
  || {
    # pg_restore returns 1 on warnings sometimes; treat only hard failures
    code=$?
    if [ "${code}" -gt 1 ]; then
      echo "ERROR: pg_restore failed (exit ${code})" >&2
      exit "${code}"
    fi
    echo "[restore] pg_restore exited ${code} (warnings) — continuing"
  }

echo "[restore] starting PM2 apps..."
if command -v pm2 >/dev/null 2>&1; then
  LINUX_USER="$(echo "${APP_DIR}" | sed -n 's|^/home/\([^/]*\)/.*|\1|p')"
  if [ -n "${LINUX_USER}" ] && id "${LINUX_USER}" >/dev/null 2>&1; then
    sudo -u "${LINUX_USER}" bash -lc "cd '${APP_DIR}' && pm2 restart ${INSTANCE_ID_UPPER}-api ${INSTANCE_ID_UPPER}-bot ${INSTANCE_ID_UPPER}-sync ${INSTANCE_ID_UPPER}-admin 2>/dev/null || pm2 start ecosystem.config.cjs 2>/dev/null || true" || true
  fi
fi

echo "[restore] ✓ finished storageKey=${STORAGE_KEY}"
