#!/usr/bin/env bash
# reset-contaminated-knowledge.sh
#
# Cleans leftover Status Blessed (or other foreign-brand) knowledge/*.txt
# that are NO LONGER injected into Claude. Business facts belong in the
# active system prompt (Admin → Prompts). Live catalog stays (CRM sync).
#
# Safe defaults:
#   - dry-run unless --apply
#   - refuses Status Blessed tenants (INSTANCE_ID sb/blessed, or BRAND_NAME match)
#   - never touches catalog.txt / services-live.txt unless --reset-catalog
#   - never touches prompts/ or DB system_prompts
#   - always writes a timestamped backup before deleting
#
# Usage (as the tenant Linux user):
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
      sed -n '2,24p' "$0"
      exit 0
      ;;
    *)
      echo "Unknown arg: $arg (try --help)" >&2
      exit 2
      ;;
  esac
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"

ENV_FILE="$APP_DIR/.env"
if [[ -f "$ENV_FILE" ]]; then
  set -a
  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ "$line" =~ ^[[:space:]]*# ]] && continue
    [[ "$line" =~ ^[[:space:]]*$ ]] && continue
    if [[ "$line" =~ ^([A-Za-z_][A-Za-z0-9_]*)=(.*)$ ]]; then
      key="${BASH_REMATCH[1]}"
      val="${BASH_REMATCH[2]}"
      val="${val%\"}"; val="${val#\"}"
      val="${val%\'}"; val="${val#\'}"
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
echo "Note:       knowledge/*.txt (except catalog) are NOT injected — use Admin → Prompts"
echo

if [[ $FORCE -eq 0 ]]; then
  if [[ "$INSTANCE_ID_LC" == "sb" || "$INSTANCE_ID_LC" == "blessed" ]]; then
    echo "REFUSED: Status Blessed tenant (INSTANCE_ID=$INSTANCE_ID). Use --force only if intentional."
    exit 3
  fi
  if [[ "$BRAND_LC" == *status*blessed* || "$BRAND_LC" == "blessed" ]]; then
    echo "REFUSED: BRAND_NAME looks like Status Blessed ($BRAND_NAME). Use --force if needed."
    exit 3
  fi
fi

if [[ ! -d "$KNOWLEDGE_DIR" ]]; then
  echo "ERROR: knowledge dir missing: $KNOWLEDGE_DIR" >&2
  exit 1
fi

MARKERS='Status Blessed|status-blessed|status\.blessed|@status_Blessed|STATUS BLESSED|статус блес'
# Legacy files that used to be injected; safe to remove when contaminated / obsolete.
LEGACY_FILES=(brand.txt contacts.txt delivery.txt faq.txt categories.txt services.txt)

TO_REMOVE=()
for f in "${LEGACY_FILES[@]}"; do
  path="$KNOWLEDGE_DIR/$f"
  [[ -f "$path" ]] || continue
  if [[ "$f" == "brand.txt" ]] || grep -Eiq "$MARKERS" "$path"; then
    TO_REMOVE+=("$f")
  fi
done

CATALOG_HIT=0
if [[ -f "$KNOWLEDGE_DIR/catalog.txt" ]] && grep -Eiq "$MARKERS" "$KNOWLEDGE_DIR/catalog.txt"; then
  CATALOG_HIT=1
fi

echo "Will remove (backup first): ${TO_REMOVE[*]:-(none)}"
if [[ $CATALOG_HIT -eq 1 ]]; then
  echo "WARN: catalog.txt mentions Status Blessed — fix KeyCRM / pass --reset-catalog."
fi
echo

if [[ ${#TO_REMOVE[@]} -eq 0 && $RESET_CATALOG -eq 0 ]]; then
  echo "Nothing to do."
  exit 0
fi

if [[ $APPLY -eq 0 ]]; then
  echo "Dry-run only. Re-run with --apply to backup + remove legacy contaminated files."
  exit 0
fi

STAMP="$(date +%Y%m%d-%H%M%S)"
BACKUP_ROOT="$(dirname "$KNOWLEDGE_DIR")/knowledge.bak.$STAMP"
mkdir -p "$BACKUP_ROOT"

echo "Backup → $BACKUP_ROOT"
for f in "${TO_REMOVE[@]}"; do
  cp -a "$KNOWLEDGE_DIR/$f" "$BACKUP_ROOT/$f"
  rm -f "$KNOWLEDGE_DIR/$f"
  echo "  removed $f"
done

if [[ $RESET_CATALOG -eq 1 && -f "$KNOWLEDGE_DIR/catalog.txt" ]]; then
  cp -a "$KNOWLEDGE_DIR/catalog.txt" "$BACKUP_ROOT/catalog.txt"
  mv "$KNOWLEDGE_DIR/catalog.txt" "$KNOWLEDGE_DIR/catalog.txt.quarantined.$STAMP"
  echo "  quarantined catalog.txt"
fi

echo
echo "Done. Next:"
echo "  1) Ensure brand/contacts/delivery/FAQ are IN the active system prompt (Admin → Prompts)."
echo "  2) Fix KeyCRM / catalog sync if catalog was SB-contaminated."
echo "  3) Test IG DM — identity and facts must come from the system prompt + live catalog."
echo "  4) Backup: $BACKUP_ROOT"
