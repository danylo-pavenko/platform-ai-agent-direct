#!/usr/bin/env bash
#
# backup-tenant-db.sh — pg_dump -Fc a tenant DB and upload to S3/MinIO.
#
# Required env:
#   INSTANCE_ID
#   APP_DIR              — tenant app root (for .env DATABASE_URL) OR DATABASE_URL
#   S3_ENDPOINT S3_BUCKET AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY
# Optional:
#   S3_REGION (default us-east-1)
#   S3_FORCE_PATH_STYLE (default true)
#   BACKUP_SOURCE (manual|scheduled|pre_deploy|pre_restore) — logged only
#
# Prints markers:
#   STORAGE_KEY=tenants/{id}/{ts}.dump
#   SHA256=...
#   BYTES=...
#
set -euo pipefail

INSTANCE_ID="${INSTANCE_ID:?INSTANCE_ID required}"
S3_ENDPOINT="${S3_ENDPOINT:?S3_ENDPOINT required}"
S3_BUCKET="${S3_BUCKET:?S3_BUCKET required}"
AWS_ACCESS_KEY_ID="${AWS_ACCESS_KEY_ID:?AWS_ACCESS_KEY_ID required}"
AWS_SECRET_ACCESS_KEY="${AWS_SECRET_ACCESS_KEY:?AWS_SECRET_ACCESS_KEY required}"
S3_REGION="${S3_REGION:-us-east-1}"
S3_FORCE_PATH_STYLE="${S3_FORCE_PATH_STYLE:-true}"
BACKUP_SOURCE="${BACKUP_SOURCE:-manual}"
export AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_DEFAULT_REGION="${S3_REGION}"

if [ -z "${DATABASE_URL:-}" ]; then
  APP_DIR="${APP_DIR:?APP_DIR or DATABASE_URL required}"
  ENV_FILE="${APP_DIR}/.env"
  if [ ! -f "${ENV_FILE}" ]; then
    echo "ERROR: ${ENV_FILE} not found and DATABASE_URL unset" >&2
    exit 1
  fi
  # shellcheck disable=SC1090
  DATABASE_URL="$(grep -E '^DATABASE_URL=' "${ENV_FILE}" | head -1 | cut -d= -f2- | sed -e 's/^"//' -e 's/"$//' -e "s/^'//" -e "s/'$//")"
  export DATABASE_URL
fi
if [ -z "${DATABASE_URL:-}" ]; then
  echo "ERROR: DATABASE_URL empty" >&2
  exit 1
fi

TS="$(date -u +%Y-%m-%dT%H-%M-%SZ)"
STORAGE_KEY="tenants/${INSTANCE_ID}/${TS}.dump"
TMP_DIR="$(mktemp -d /tmp/sa-backup-XXXXXX)"
DUMP_FILE="${TMP_DIR}/${INSTANCE_ID}.dump"
cleanup() { rm -rf "${TMP_DIR}"; }
trap cleanup EXIT

echo "[backup] source=${BACKUP_SOURCE} instance=${INSTANCE_ID}"
echo "[backup] dumping Postgres (custom format)..."
pg_dump --no-owner --no-acl -Fc -f "${DUMP_FILE}" "${DATABASE_URL}"
BYTES="$(wc -c <"${DUMP_FILE}" | tr -d ' ')"
SHA256="$(sha256sum "${DUMP_FILE}" | awk '{print $1}')"
echo "[backup] size=${BYTES} sha256=${SHA256}"

upload_aws() {
  local extra=(--endpoint-url "${S3_ENDPOINT}")
  if [ "${S3_FORCE_PATH_STYLE}" = "true" ] || [ "${S3_FORCE_PATH_STYLE}" = "1" ]; then
    # awscli v1/v2 path-style via addressing style config
    export AWS_S3_ADDRESSING_STYLE=path
  fi
  aws s3 cp "${DUMP_FILE}" "s3://${S3_BUCKET}/${STORAGE_KEY}" "${extra[@]}"
}

upload_mc() {
  local alias="sabackup$$"
  mc alias set "${alias}" "${S3_ENDPOINT}" "${AWS_ACCESS_KEY_ID}" "${AWS_SECRET_ACCESS_KEY}" >/dev/null
  mc cp "${DUMP_FILE}" "${alias}/${S3_BUCKET}/${STORAGE_KEY}"
  mc alias remove "${alias}" >/dev/null 2>&1 || true
}

echo "[backup] uploading s3://${S3_BUCKET}/${STORAGE_KEY}"
if command -v aws >/dev/null 2>&1; then
  upload_aws
elif command -v mc >/dev/null 2>&1; then
  upload_mc
else
  echo "ERROR: neither aws nor mc found on PATH — install awscli or minio client" >&2
  exit 1
fi

# Optional latest pointer (best-effort JSON)
LATEST_JSON="${TMP_DIR}/latest.json"
printf '{"storageKey":"%s","sha256":"%s","bytes":%s,"createdAt":"%s","source":"%s"}\n' \
  "${STORAGE_KEY}" "${SHA256}" "${BYTES}" "${TS}" "${BACKUP_SOURCE}" >"${LATEST_JSON}"
if command -v aws >/dev/null 2>&1; then
  aws s3 cp "${LATEST_JSON}" "s3://${S3_BUCKET}/tenants/${INSTANCE_ID}/latest.json" --endpoint-url "${S3_ENDPOINT}" >/dev/null 2>&1 || true
elif command -v mc >/dev/null 2>&1; then
  mc cp "${LATEST_JSON}" "sabackup$$/${S3_BUCKET}/tenants/${INSTANCE_ID}/latest.json" >/dev/null 2>&1 || true
fi

echo "[backup] ✓ uploaded"
echo "STORAGE_KEY=${STORAGE_KEY}"
echo "SHA256=${SHA256}"
echo "BYTES=${BYTES}"
