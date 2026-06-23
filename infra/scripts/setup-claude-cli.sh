#!/usr/bin/env bash
#
# setup-claude-cli.sh — Idempotent Claude Code CLI install for a tenant Linux user.
#
# Runtime expects: ~/.local/bin/claude (see apps/backend/src/services/claude.ts).
# Called from provision-client.sh (via sudo -u tenant) and deploy-client.sh.
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [[ "${EUID:-$(id -u)}" -eq 0 ]]; then
  echo "  ERROR: Do not run setup-claude-cli.sh as root." >&2
  echo "  Provision: sudo -u <tenant> bash ${SCRIPT_DIR}/setup-claude-cli.sh" >&2
  exit 1
fi

CLAUDE_BIN="${HOME}/.local/bin/claude"
CLAUDE_INSTALL_URL="${CLAUDE_INSTALL_URL:-https://claude.ai/install.sh}"

claude_cli_ready() {
  [[ -x "${CLAUDE_BIN}" ]] && "${CLAUDE_BIN}" --version >/dev/null 2>&1
}

if claude_cli_ready; then
  echo "  [claude] CLI OK: $("${CLAUDE_BIN}" --version 2>/dev/null | head -1)"
  echo "  [claude] Path: ${CLAUDE_BIN}"
  exit 0
fi

if ! command -v curl >/dev/null 2>&1; then
  echo "  ERROR: curl is required to install Claude Code CLI" >&2
  exit 1
fi

mkdir -p "${HOME}/.local/bin"

echo "  [claude] Installing Claude Code CLI (${CLAUDE_INSTALL_URL})..."
curl -fsSL "${CLAUDE_INSTALL_URL}" | bash

if ! claude_cli_ready; then
  if command -v claude >/dev/null 2>&1 && [[ "$(command -v claude)" != "${CLAUDE_BIN}" ]]; then
    echo "  [claude] Linking $(command -v claude) → ${CLAUDE_BIN}"
    ln -sf "$(command -v claude)" "${CLAUDE_BIN}"
  fi
fi

if ! claude_cli_ready; then
  echo "  ERROR: Claude CLI install finished but ${CLAUDE_BIN} is missing or not executable." >&2
  echo "  Auth is still required after install: tenant admin → Settings → Claude, or: claude auth login" >&2
  exit 1
fi

echo "  [claude] Installed: $("${CLAUDE_BIN}" --version 2>/dev/null | head -1)"
echo "  [claude] Path: ${CLAUDE_BIN}"
echo "  [claude] Next: authorize in tenant admin Settings (or run: claude auth login)"
