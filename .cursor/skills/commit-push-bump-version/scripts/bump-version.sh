#!/usr/bin/env bash
# bump-version.sh — Increment VERSION.json code (+1). Bump name every 10 codes.
#
# Usage (from repo root):
#   bash .cursor/skills/commit-push-bump-version/scripts/bump-version.sh
#
# Prints: name=1.1 code=10 label=v1.1 (10)
set -euo pipefail

ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
VERSION_FILE="${ROOT}/VERSION.json"

if [[ ! -f "${VERSION_FILE}" ]]; then
  printf '{"name":"1.0","code":1}\n' > "${VERSION_FILE}"
fi

python3 - <<'PY' "${VERSION_FILE}"
import json, sys
from pathlib import Path

path = Path(sys.argv[1])
data = json.loads(path.read_text(encoding="utf-8"))
name = str(data.get("name") or "1.0").strip() or "1.0"
code = int(data.get("code") or 0)
code += 1

# Every 10th code value (10, 20, 30…) bumps the marketing name minor.
if code % 10 == 0:
    parts = name.split(".")
    try:
        major = int(parts[0])
        minor = int(parts[1]) if len(parts) > 1 else 0
    except ValueError:
        major, minor = 1, 0
    minor += 1
    name = f"{major}.{minor}"

path.write_text(json.dumps({"name": name, "code": code}, indent=2) + "\n", encoding="utf-8")
print(f"name={name} code={code} label=v{name} ({code})")
PY

# Keep root package.json version in sync with marketing name (optional nicety).
PKG="${ROOT}/package.json"
if [[ -f "${PKG}" ]] && command -v node >/dev/null 2>&1; then
  NAME="$(python3 -c "import json; print(json.load(open('${VERSION_FILE}'))['name'])")"
  CODE="$(python3 -c "import json; print(json.load(open('${VERSION_FILE}'))['code'])")"
  node -e "
    const fs = require('fs');
    const p = '${PKG}';
    const pkg = JSON.parse(fs.readFileSync(p, 'utf8'));
    pkg.version = '${NAME}.${CODE}';
    fs.writeFileSync(p, JSON.stringify(pkg, null, 2) + '\n');
  "
fi
