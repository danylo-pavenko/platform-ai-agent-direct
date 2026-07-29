#!/usr/bin/env bash
# reset-contaminated-knowledge.sh
#
# Replaces leftover Status Blessed (or other foreign-brand) knowledge/*.txt
# with the current generic templates from the repo.
#
# Safe defaults:
#   - dry-run unless --apply
#   - refuses Status Blessed tenants (INSTANCE_ID sb/blessed, or BRAND_NAME match)
#   - never touches catalog.txt / services-live.txt (CRM sync) unless --reset-catalog
#   - never touches prompts/ or DB system_prompts
#   - always writes a timestamped backup before deleting
#
# Usage (as the tenant Linux user, from the app dir or any cwd):
#   bash infra/scripts/reset-contaminated-knowledge.sh
#   bash infra/scripts/reset-contaminated-knowledge.sh --apply
#   bash infra/scripts/reset-contaminated-knowledge.sh --apply --reset-catalog
#
# Or as agentsadmin:
#   sudo -u pavenko -i bash ~/platform-ai-agent-direct/infra/scripts/reset-contaminated-knowledge.sh --apply

set -euo pipefail

APPLY=0
RESET_CATALOG=0
FORCE=0

for arg in "$@"; do
  case "$arg" in
    --apply) APPLY=1 ;;
    --reset-catalog) RESET_CATALOG=1 ;;
    --force) FORCE=1 ;;
    -h|--help)
      sed -n '2,25p' "$0"
      exit 0
      ;;
    *)
      echo "Unknown arg: $arg (try --help)" >&2
      exit 2
      ;;
  esac
done

# Resolve app root (script lives in infra/scripts/)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
TEMPLATES_KNOWLEDGE="$APP_DIR/apps/workspace/templates/knowledge"

if [[ ! -d "$TEMPLATES_KNOWLEDGE" ]]; then
  echo "ERROR: templates not found at $TEMPLATES_KNOWLEDGE" >&2
  exit 1
fi

# Load tenant .env if present (INSTANCE_ID, BRAND_NAME, TENANT_KNOWLEDGE_DIR)
ENV_FILE="$APP_DIR/.env"
if [[ -f "$ENV_FILE" ]]; then
  # shellcheck disable=SC1090
  set -a
  # Only export simple KEY=VALUE lines (skip comments / exports with spaces in odd ways)
  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ "$line" =~ ^[[:space:]]*# ]] && continue
    [[ "$line" =~ ^[[:space:]]*$ ]] && continue
    if [[ "$line" =~ ^([A-Za-z_][A-Za-z0-9_]*)=(.*)$ ]]; then
      key="${BASH_REMATCH[1]}"
      val="${BASH_REMATCH[2]}"
      val="${val%\"}"
      val="${val#\"}"
      val="${val%\'}"
      val="${val#\'}"
      export "$key=$val"
    fi
  done < "$ENV_FILE"
  set +a
fi

KNOWLEDGE_DIR="${TENANT_KNOWLEDGE_DIR:-$HOME/tenant_knowledge}/knowledge"
INSTANCE_ID_LC="$(echo "${INSTANCE_ID:-}" | tr '[:upper:]' '[:lower:]')"
BRAND_LC="$(echo "${BRAND_NAME:-}" | tr '[:upper:]' '[:lower:]')"

echo "App:        $APP_DIR"
echo "Knowledge:  $KNOWLEDGE_DIR"
echo "INSTANCE:   ${INSTANCE_ID:-"(unset)"}"
echo "BRAND:      ${BRAND_NAME:-"(unset)"}"
echo "Mode:       $([[ $APPLY -eq 1 ]] && echo APPLY || echo DRY-RUN)"
echo

# Protect the real Status Blessed tenant
if [[ $FORCE -eq 0 ]]; then
  if [[ "$INSTANCE_ID_LC" == "sb" || "$INSTANCE_ID_LC" == "blessed" ]]; then
    echo "REFUSED: this looks like the Status Blessed tenant (INSTANCE_ID=$INSTANCE_ID)."
    echo "Those knowledge files are intentional. Use --force only if you really mean it."
    exit 3
  fi
  if [[ "$BRAND_LC" == *status*blessed* || "$BRAND_LC" == "blessed" ]]; then
    echo "REFUSED: BRAND_NAME looks like Status Blessed ($BRAND_NAME)."
    echo "Use --force only if this is NOT the SB production tenant."
    exit 3
  fi
fi

if [[ ! -d "$KNOWLEDGE_DIR" ]]; then
  echo "ERROR: knowledge dir missing: $KNOWLEDGE_DIR" >&2
  exit 1
fi

# Contamination markers (case-insensitive via grep -i)
MARKERS='Status Blessed|status-blessed|status\.blessed|@status_Blessed|STATUS BLESSED|статус блес'

SEED_FILES=(brand.txt contacts.txt delivery.txt faq.txt categories.txt services.txt)
CONTAMINATED=()
CLEAN=()
MISSING=()

for f in "${SEED_FILES[@]}"; do
  path="$KNOWLEDGE_DIR/$f"
  if [[ ! -f "$path" ]]; then
    MISSING+=("$f")
    continue
  fi
  if grep -Eiq "$MARKERS" "$path"; then
    CONTAMINATED+=("$f")
  else
    CLEAN+=("$f")
  fi
done

CATALOG_HIT=0
if [[ -f "$KNOWLEDGE_DIR/catalog.txt" ]] && grep -Eiq "$MARKERS" "$KNOWLEDGE_DIR/catalog.txt"; then
  CATALOG_HIT=1
fi

echo "Contaminated (will reset): ${CONTAMINATED[*]:-(none)}"
echo "Clean (leave alone):       ${CLEAN[*]:-(none)}"
echo "Missing (will seed):       ${MISSING[*]:-(none)}"
if [[ $CATALOG_HIT -eq 1 ]]; then
  echo "WARN: catalog.txt also mentions Status Blessed — CRM sync / KeyCRM for this tenant is likely wrong."
  if [[ $RESET_CATALOG -eq 1 ]]; then
    echo "       --reset-catalog: will move catalog.txt aside (empty until next sync)."
  else
    echo "       Not touching catalog.txt (pass --reset-catalog to quarantine it)."
  fi
fi
echo

if [[ ${#CONTAMINATED[@]} -eq 0 && ${#MISSING[@]} -eq 0 && $RESET_CATALOG -eq 0 ]]; then
  echo "Nothing to do."
  exit 0
fi

if [[ $APPLY -eq 0 ]]; then
  echo "Dry-run only. Re-run with --apply to backup + replace contaminated seed files with templates."
  exit 0
fi

STAMP="$(date +%Y%m%d-%H%M%S)"
BACKUP_ROOT="$(dirname "$KNOWLEDGE_DIR")/knowledge.bak.$STAMP"
mkdir -p "$BACKUP_ROOT"

reset_one() {
  local f="$1"
  local src="$TEMPLATES_KNOWLEDGE/$f"
  local dest="$KNOWLEDGE_DIR/$f"
  if [[ -f "$dest" ]]; then
    cp -a "$dest" "$BACKUP_ROOT/$f"
    rm -f "$dest"
  fi
  if [[ -f "$src" ]]; then
    cp -a "$src" "$dest"
    echo "  reset $f ← templates"
  else
    echo "  WARN: no template for $f (removed only)" >&2
  fi
}

echo "Backup → $BACKUP_ROOT"
for f in "${CONTAMINATED[@]}"; do
  reset_one "$f"
done
for f in "${MISSING[@]}"; do
  reset_one "$f"
done

if [[ $RESET_CATALOG -eq 1 && -f "$KNOWLEDGE_DIR/catalog.txt" ]]; then
  cp -a "$KNOWLEDGE_DIR/catalog.txt" "$BACKUP_ROOT/catalog.txt"
  mv "$KNOWLEDGE_DIR/catalog.txt" "$KNOWLEDGE_DIR/catalog.txt.quarantined.$STAMP"
  echo "  quarantined catalog.txt"
fi

echo
echo "Done. Next:"
echo "  1) Edit $KNOWLEDGE_DIR/brand.txt (and contacts/delivery/faq) for THIS tenant."
echo "  2) Fix KeyCRM / catalog sync if catalog was SB-contaminated."
echo "  3) Send a test IG DM — identity must match the active system prompt, not Status Blessed."
echo "  4) Backup kept at: $BACKUP_ROOT"
