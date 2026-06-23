#!/usr/bin/env bash
#
# tenant-domains.sh — shared helpers for platform subdomain naming and TLS paths.
# Sourced by provision-client.sh and update-nginx.sh (do not execute directly).
#

# Base domain for platform-managed tenant hostnames (api-{slug}.BASE, agent-{slug}.BASE).
PLATFORM_BASE_DOMAIN="${PLATFORM_BASE_DOMAIN:-direct-ai-agents.com}"

# Let's Encrypt cert directory name under /etc/letsencrypt/live/.
# If certbot created a second line (e.g. direct-ai-agents.com-0001 for wildcard), set
# PLATFORM_TLS_CERT_NAME or rely on auto-discovery below.
PLATFORM_TLS_CERT_NAME="${PLATFORM_TLS_CERT_NAME:-${PLATFORM_BASE_DOMAIN}}"

# Port allocation for new tenants (--platform-auto).
PLATFORM_PORT_BASE="${PLATFORM_PORT_BASE:-3100}"
PLATFORM_PORT_STEP="${PLATFORM_PORT_STEP:-100}"
PLATFORM_PORT_MAX="${PLATFORM_PORT_MAX:-9900}"

tenant_domains_validate_instance_id() {
  local id="$1"
  if [[ ! "${id}" =~ ^[a-z0-9-]{2,24}$ ]]; then
    echo "ERROR: INSTANCE_ID must match ^[a-z0-9-]{2,24}$ (lowercase). Got: ${id}" >&2
    return 1
  fi
}

tenant_domains_from_slug() {
  local slug="$1"
  tenant_domains_validate_instance_id "${slug}" || return 1
  API_DOMAIN="api-${slug}.${PLATFORM_BASE_DOMAIN}"
  ADMIN_DOMAIN="agent-${slug}.${PLATFORM_BASE_DOMAIN}"
  export API_DOMAIN ADMIN_DOMAIN
}

tenant_domains_is_platform_host() {
  local domain="$1"
  [[ "${domain}" == api-*."${PLATFORM_BASE_DOMAIN}" || "${domain}" == agent-*."${PLATFORM_BASE_DOMAIN}" ]]
}

# True when fullchain.pem includes *.PLATFORM_BASE_DOMAIN (real wildcard, not apex-only).
tenant_domains_ssl_cert_covers_wildcard() {
  local cert_file="$1"
  [[ -f "${cert_file}" ]] || return 1
  openssl x509 -in "${cert_file}" -noout -text 2>/dev/null \
    | grep -qF "DNS:*.${PLATFORM_BASE_DOMAIN}"
}

# Find live cert dir that includes *.PLATFORM_BASE_DOMAIN (handles certbot -0001 suffix dirs).
tenant_domains_find_wildcard_cert_dir() {
  local base="${PLATFORM_BASE_DOMAIN}"
  local dir
  for dir in \
    "/etc/letsencrypt/live/${PLATFORM_TLS_CERT_NAME}" \
    "/etc/letsencrypt/live/${base}" \
    "/etc/letsencrypt/live/${base}-0001" \
    "/etc/letsencrypt/live/${base}-0002" \
    "/etc/letsencrypt/live/${base}-0003"; do
    if [[ -f "${dir}/fullchain.pem" ]] \
      && tenant_domains_ssl_cert_covers_wildcard "${dir}/fullchain.pem"; then
      echo "${dir}"
      return 0
    fi
  done
  return 1
}

# Returns cert directory path (without trailing slash) for nginx ssl_certificate directives.
tenant_domains_resolve_ssl_cert_dir() {
  local api_domain="$1"
  local admin_domain="$2"
  local wildcard_dir=""

  if tenant_domains_is_platform_host "${api_domain}" \
    && tenant_domains_is_platform_host "${admin_domain}" \
    && wildcard_dir="$(tenant_domains_find_wildcard_cert_dir)"; then
    echo "${wildcard_dir}"
    return 0
  fi

  # Legacy: per-domain certs (admin and api may differ — caller picks per server_name).
  echo ""
}

tenant_domains_per_domain_cert_dir() {
  local domain="$1"
  echo "/etc/letsencrypt/live/${domain}"
}

tenant_domains_next_free_port_pair() {
  local port="${PLATFORM_PORT_BASE}"
  while [[ "${port}" -le "${PLATFORM_PORT_MAX}" ]]; do
    local admin_port=$((port + 1))
    if ! ss -tlnp 2>/dev/null | grep -qE ":${port} " \
      && ! ss -tlnp 2>/dev/null | grep -qE ":${admin_port} "; then
      echo "${port} ${admin_port}"
      return 0
    fi
    port=$((port + PLATFORM_PORT_STEP))
  done
  echo "ERROR: No free API/Admin port pair in range ${PLATFORM_PORT_BASE}-${PLATFORM_PORT_MAX} (step ${PLATFORM_PORT_STEP})" >&2
  return 1
}

tenant_domains_usage() {
  cat <<'EOF'
Usage (legacy — custom domains, unchanged):
  provision-client.sh <INSTANCE_ID> <CLIENT_NAME> <API_DOMAIN> <ADMIN_DOMAIN> <API_PORT> <ADMIN_PORT>

  Example:
    provision-client.sh blessed Blessed api.status-blessed.com agent.status-blessed.com 3100 3101

Usage (platform — auto hostnames api-{slug}.direct-ai-agents.com):
  provision-client.sh <INSTANCE_ID> <CLIENT_NAME> --platform <API_PORT> <ADMIN_PORT>

  Example:
    provision-client.sh cultura "Cultura Barbershop" --platform 3200 3201
    # → api-cultura.direct-ai-agents.com, agent-cultura.direct-ai-agents.com

Usage (platform — auto hostnames + next free port pair):
  provision-client.sh <INSTANCE_ID> <CLIENT_NAME> --platform-auto

  Example:
    provision-client.sh acme "Acme Store" --platform-auto

Environment (optional):
  PLATFORM_BASE_DOMAIN     default: direct-ai-agents.com
  PLATFORM_TLS_CERT_NAME   wildcard cert dir name (default: PLATFORM_BASE_DOMAIN)
  PLATFORM_PORT_BASE       first port to try for --platform-auto (default: 3100)
  PLATFORM_PORT_STEP       step between tenants (default: 100)
EOF
}
