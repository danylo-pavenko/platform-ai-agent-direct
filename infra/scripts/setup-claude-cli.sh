#!/usr/bin/env bash
#
# setup-claude-cli.sh — Idempotent Claude Code CLI install + update for a tenant Linux user.
#
# Runtime expects: ~/.local/bin/claude (see apps/backend/src/services/claude.ts).
# Called from provision-client.sh (via sudo -u tenant) and deploy-client.sh.
#
# Env:
#   CLAUDE_INSTALL_URL     — native installer URL (default https://claude.ai/install.sh)
#   CLAUDE_SKIP_UPDATE=1    — only ensure install, never run `claude update`
#   CLAUDE_UPDATE_TIMEOUT_SEC — max seconds for `claude update` (default 180)
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
CLAUDE_UPDATE_TIMEOUT_SEC="${CLAUDE_UPDATE_TIMEOUT_SEC:-180}"
LOCAL_BIN_PATH_LINE='export PATH="$HOME/.local/bin:$PATH"'

claude_cli_ready() {
  [[ -x "${CLAUDE_BIN}" ]] && "${CLAUDE_BIN}" --version >/dev/null 2>&1
}

claude_version_line() {
  "${CLAUDE_BIN}" --version 2>/dev/null | head -1 || echo "(unknown)"
}

# Installer warns when ~/.local/bin is missing from PATH — fix for interactive SSH.
ensure_local_bin_in_path() {
  if [[ ":${PATH}:" != *":${HOME}/.local/bin:"* ]]; then
    export PATH="${HOME}/.local/bin:${PATH}"
  fi

  local shell_rc="${HOME}/.bashrc"
  if [ -f "${shell_rc}" ]; then
    if ! grep -qE '(^|:)\$HOME/.local/bin|\.local/bin' "${shell_rc}" 2>/dev/null; then
      {
        echo ""
        echo "# Claude Code CLI (setup-claude-cli.sh)"
        echo "${LOCAL_BIN_PATH_LINE}"
      } >> "${shell_rc}"
      echo "  [claude] Added ~/.local/bin to ${shell_rc}"
    fi
  else
    cat > "${shell_rc}" <<EOF
# ~/.bashrc — created by setup-claude-cli.sh
${LOCAL_BIN_PATH_LINE}
EOF
    echo "  [claude] Created ${shell_rc} with ~/.local/bin in PATH"
  fi

  local profile="${HOME}/.profile"
  if [ ! -f "${profile}" ]; then
    cat > "${profile}" <<'EOF'
# ~/.profile — login shells
[[ -f "$HOME/.bashrc" ]] && . "$HOME/.bashrc"
EOF
    echo "  [claude] Created ${profile} (sources .bashrc)"
  elif ! grep -qE '\.bashrc|\.local/bin' "${profile}" 2>/dev/null; then
    {
      echo ""
      echo "# Claude Code CLI (setup-claude-cli.sh)"
      echo '[[ -f "$HOME/.bashrc" ]] && . "$HOME/.bashrc"'
    } >> "${profile}"
    echo "  [claude] Updated ${profile} to source .bashrc"
  fi
}

report_claude_path() {
  echo "  [claude] Path: ${CLAUDE_BIN}"
  if command -v claude >/dev/null 2>&1; then
    echo "  [claude] PATH: claude → $(command -v claude)"
  else
    echo "  [claude] PATH: run 'source ~/.bashrc' or open a new SSH session for 'claude' command"
  fi
}

# Force latest channel update (native installs also auto-update in background;
# this applies immediately on deploy without waiting for the next check).
maybe_update_claude() {
  if [[ "${CLAUDE_SKIP_UPDATE:-0}" == "1" ]]; then
    echo "  [claude] Update skipped (CLAUDE_SKIP_UPDATE=1)"
    return 0
  fi

  local before after
  before="$(claude_version_line)"
  echo "  [claude] Checking for CLI updates (current: ${before})..."

  set +e
  if command -v timeout >/dev/null 2>&1; then
    timeout --foreground "${CLAUDE_UPDATE_TIMEOUT_SEC}" "${CLAUDE_BIN}" update
  else
    "${CLAUDE_BIN}" update
  fi
  local rc=$?
  set -e

  if [[ "${rc}" -eq 124 ]]; then
    echo "  [claude] WARN: update timed out after ${CLAUDE_UPDATE_TIMEOUT_SEC}s — keeping ${before}" >&2
    return 0
  fi
  if [[ "${rc}" -ne 0 ]]; then
    echo "  [claude] WARN: update exited ${rc} — keeping ${before} (deploy continues)" >&2
    return 0
  fi

  after="$(claude_version_line)"
  if [[ "${before}" == "${after}" ]]; then
    echo "  [claude] Already up to date: ${after}"
  else
    echo "  [claude] Updated: ${before} → ${after}"
  fi
}

install_claude_cli() {
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

  echo "  [claude] Installed: $(claude_version_line)"
}

# ── main ──
if claude_cli_ready; then
  ensure_local_bin_in_path
  echo "  [claude] CLI OK: $(claude_version_line)"
  report_claude_path
  maybe_update_claude
  exit 0
fi

install_claude_cli
ensure_local_bin_in_path
report_claude_path
echo "  [claude] Next: authorize in tenant admin Settings (or run: claude auth login)"
