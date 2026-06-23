#!/usr/bin/env bash
#
# setup-platform-wildcard-tls.sh — One-time wildcard TLS for platform tenant subdomains.
#
# Issues a cert covering:
#   *.direct-ai-agents.com
#   direct-ai-agents.com
#
# Requires DNS-01 (HTTP-01 cannot issue wildcards). Install the Cloudflare plugin once:
#   apt install python3-certbot-dns-cloudflare
#   install -m 600 /path/to/cloudflare.ini /root/.secrets/cloudflare.ini
#     # cloudflare.ini: dns_cloudflare_api_token = YOUR_TOKEN
#
# Run as root:
#   CERTBOT_EMAIL=you@example.com bash infra/scripts/setup-platform-wildcard-tls.sh
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/tenant-domains.sh
source "${SCRIPT_DIR}/lib/tenant-domains.sh"

CERTBOT_EMAIL="${CERTBOT_EMAIL:-}"
CLOUDFLARE_CREDENTIALS="${CLOUDFLARE_CREDENTIALS:-/root/.secrets/cloudflare.ini}"

if [[ $EUID -ne 0 ]]; then
  echo "ERROR: Run as root"
  exit 1
fi

if [[ -z "${CERTBOT_EMAIL}" ]]; then
  read -rp "Email for Let's Encrypt: " CERTBOT_EMAIL
fi

echo "══════════════════════════════════════════════"
echo "  Platform wildcard TLS"
echo "  Domains: *.${PLATFORM_BASE_DOMAIN}, ${PLATFORM_BASE_DOMAIN}"
echo "  Cert name: ${PLATFORM_TLS_CERT_NAME}"
echo "══════════════════════════════════════════════"

if tenant_domains_ssl_cert_covers_wildcard "/etc/letsencrypt/live/${PLATFORM_TLS_CERT_NAME}/fullchain.pem"; then
  echo "Wildcard cert already present at /etc/letsencrypt/live/${PLATFORM_TLS_CERT_NAME}"
  echo "Renew with: certbot renew"
  exit 0
fi

if [[ -f "/etc/letsencrypt/live/${PLATFORM_TLS_CERT_NAME}/fullchain.pem" ]]; then
  echo "WARNING: Cert exists at /etc/letsencrypt/live/${PLATFORM_TLS_CERT_NAME} but does NOT cover *.${PLATFORM_BASE_DOMAIN}"
  echo "         (likely apex-only from landing setup). Re-issuing wildcard via DNS-01..."
  EXPAND_ARGS=(--expand)
else
  EXPAND_ARGS=()
fi

if [[ ! -f "${CLOUDFLARE_CREDENTIALS}" ]]; then
  cat <<EOF
ERROR: Cloudflare credentials not found at ${CLOUDFLARE_CREDENTIALS}

Create the file (mode 600):
  dns_cloudflare_api_token = <token with Zone:DNS:Edit on ${PLATFORM_BASE_DOMAIN}>

Then re-run this script.

Alternative: obtain the wildcard cert manually on any machine with DNS-01 and copy
/etc/letsencrypt/live/${PLATFORM_TLS_CERT_NAME}/ to this server.
EOF
  exit 1
fi

certbot certonly \
  --dns-cloudflare \
  --dns-cloudflare-credentials "${CLOUDFLARE_CREDENTIALS}" \
  --non-interactive \
  --agree-tos \
  --email "${CERTBOT_EMAIL}" \
  "${EXPAND_ARGS[@]}" \
  -d "*.${PLATFORM_BASE_DOMAIN}" \
  -d "${PLATFORM_BASE_DOMAIN}"

echo ""
echo "✓ Wildcard cert ready: /etc/letsencrypt/live/${PLATFORM_TLS_CERT_NAME}/"
echo "  New tenants in --platform mode will use this cert (no per-domain certbot)."
echo "  Ensure DNS: *.${PLATFORM_BASE_DOMAIN} → this server's public IP"
