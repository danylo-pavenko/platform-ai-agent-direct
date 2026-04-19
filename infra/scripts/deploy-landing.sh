#!/usr/bin/env bash
#
# deploy-landing.sh — Copy landing page to /var/www/direct-ai-agents.com/
#
# Run as root (or agentsadmin with sudo) whenever landing HTML is updated:
#   bash infra/scripts/deploy-landing.sh
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LANDING_SRC="${SCRIPT_DIR}/../landing"
LANDING_DEST="/var/www/direct-ai-agents.com"

echo "Deploying landing → ${LANDING_DEST}"

mkdir -p "${LANDING_DEST}"
cp -r "${LANDING_SRC}/." "${LANDING_DEST}/"
chown -R www-data:www-data "${LANDING_DEST}"

echo "Done. Visit https://direct-ai-agents.com"
