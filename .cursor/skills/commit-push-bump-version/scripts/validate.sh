#!/usr/bin/env bash
# Pre-flight checks before commit/push/bump (project skill).
# Run from the repository root.
#
# Usage:
#   COMMIT_MSG='message' bash .cursor/skills/commit-push-bump-version/scripts/validate.sh
set -euo pipefail

err() { printf '%s\n' "$*" >&2; }

if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  err "validate.sh: not a git repository."
  exit 1
fi

if [[ -z "$(git status --porcelain)" ]]; then
  err "validate.sh: nothing to commit — working tree clean."
  exit 1
fi

if [[ -n "${COMMIT_MSG:-}" ]]; then
  trimmed="${COMMIT_MSG#"${COMMIT_MSG%%[![:space:]]*}"}"
  trimmed="${trimmed%"${trimmed##*[![:space:]]}"}"
  if [[ -z "${trimmed}" ]]; then
    err "validate.sh: COMMIT_MSG is empty."
    exit 1
  fi
  if [[ ${#trimmed} -gt 200 ]]; then
    err "validate.sh: COMMIT_MSG too long (${#trimmed} chars)."
    exit 1
  fi
  printf 'validate.sh: COMMIT_MSG length OK (%s chars).\n' "${#trimmed}"
fi

if ! git remote get-url origin >/dev/null 2>&1; then
  err "validate.sh: remote origin is not configured."
  exit 1
fi

printf 'validate.sh: working tree has changes (OK to commit).\n'
printf 'validate.sh: remote "origin" is configured.\n'
printf 'validate.sh: OK\n'
