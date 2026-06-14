#!/usr/bin/env bash
#
# install-whisper-system-deps.sh — OS packages for faster-whisper STT (Ubuntu/Debian).
#
# Run once per server (or after fresh VPS), as root:
#   sudo bash infra/scripts/install-whisper-system-deps.sh
#
# Idempotent: skips packages that are already installed and working.
#
set -euo pipefail

if [[ "${EUID:-$(id -u)}" -ne 0 ]]; then
  echo "ERROR: Run as root, e.g.: sudo bash $(basename "$0")" >&2
  exit 1
fi

if ! command -v apt-get >/dev/null 2>&1; then
  echo "ERROR: This script supports apt-based systems (Ubuntu/Debian) only." >&2
  exit 1
fi

echo "══════════════════════════════════════════════"
echo "  Whisper STT — system dependencies (apt)"
echo "  $(date '+%Y-%m-%d %H:%M:%S')"
echo "══════════════════════════════════════════════"

apt_get_install() {
  local pkg="$1"
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq "$pkg"
}

pkg_installed() {
  dpkg -s "$1" >/dev/null 2>&1
}

install_pkg_if_missing() {
  local pkg="$1"
  if pkg_installed "${pkg}"; then
    echo "  [skip] ${pkg} — already installed"
  else
    echo "  [apt]  installing ${pkg}..."
    apt_get_install "${pkg}"
    echo "  [done] ${pkg}"
  fi
}

# ── 1. apt index ──
echo "[1/3] apt-get update..."
apt-get update -qq

# ── 2. ffmpeg + ffprobe (IG voice notes: m4a/aac decode) ──
echo "[2/3] ffmpeg / ffprobe..."
if command -v ffmpeg >/dev/null 2>&1 && command -v ffprobe >/dev/null 2>&1; then
  echo "  [skip] ffmpeg — $(ffmpeg -version 2>/dev/null | head -1 || echo 'present')"
else
  install_pkg_if_missing ffmpeg
  if ! command -v ffmpeg >/dev/null 2>&1 || ! command -v ffprobe >/dev/null 2>&1; then
    echo "ERROR: ffmpeg/ffprobe not available after install" >&2
    exit 1
  fi
  echo "  [ok]   $(ffmpeg -version 2>/dev/null | head -1)"
fi

# ── 3. Python 3.10+ with venv ──
echo "[3/3] Python 3.10+ and venv module..."

# Newest first; package names on Ubuntu 24.04 / 22.04 (+ optional 3.12 on 22 via deadsnakes).
PYTHON_VENV_CANDIDATES=(
  "python3.12 python3.12-venv"
  "python3.11 python3.11-venv"
  "python3.10 python3.10-venv"
  "python3 python3-venv"
)

SELECTED_PYTHON=""
SELECTED_VENV_PKG=""

pick_python_pair() {
  local py pkg
  for entry in "${PYTHON_VENV_CANDIDATES[@]}"; do
    read -r py pkg <<< "${entry}"
    if apt-cache show "${pkg}" >/dev/null 2>&1; then
      SELECTED_PYTHON="${py}"
      SELECTED_VENV_PKG="${pkg}"
      return 0
    fi
  done
  return 1
}

if ! pick_python_pair; then
  echo "ERROR: No python3.x-venv package found in apt. Try: apt install python3-venv" >&2
  exit 1
fi

install_pkg_if_missing "${SELECTED_PYTHON}"
install_pkg_if_missing "${SELECTED_VENV_PKG}"

# Minimal python3.x packages on Ubuntu omit ensurepip; venv then has no pip.
FULL_PKG="${SELECTED_PYTHON}-full"
if apt-cache show "${FULL_PKG}" >/dev/null 2>&1; then
  install_pkg_if_missing "${FULL_PKG}"
fi

if ! command -v "${SELECTED_PYTHON}" >/dev/null 2>&1; then
  echo "ERROR: ${SELECTED_PYTHON} not found after install" >&2
  exit 1
fi

PY_VER="$("${SELECTED_PYTHON}" -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")')"
PY_MAJOR="${PY_VER%%.*}"
PY_MINOR="${PY_VER#*.}"

if [ "${PY_MAJOR}" -lt 3 ] || { [ "${PY_MAJOR}" -eq 3 ] && [ "${PY_MINOR}" -lt 10 ]; }; then
  echo "ERROR: ${SELECTED_PYTHON} is ${PY_VER}; faster-whisper requires Python 3.10+" >&2
  exit 1
fi

# Smoke-test venv module (does not create a persistent venv).
TMP_VENV="$(mktemp -d)/whisper-venv-smoke"
if ! "${SELECTED_PYTHON}" -m venv "${TMP_VENV}" >/dev/null 2>&1; then
  rm -rf "$(dirname "${TMP_VENV}")"
  echo "ERROR: ${SELECTED_PYTHON} -m venv failed — check ${SELECTED_VENV_PKG}" >&2
  exit 1
fi
rm -rf "$(dirname "${TMP_VENV}")"

echo "  [ok]   ${SELECTED_PYTHON} ($("${SELECTED_PYTHON}" --version 2>&1))"
echo "  [ok]   venv package: ${SELECTED_VENV_PKG}"

echo ""
echo "══════════════════════════════════════════════"
echo "  System deps ready for faster-whisper"
echo "══════════════════════════════════════════════"
echo ""
echo "  Next (as tenant user, in repo root):"
echo "    bash infra/scripts/deploy-client.sh"
echo "  or only tenant whisper setup:"
echo "    bash infra/scripts/setup-whisper.sh"
echo ""
