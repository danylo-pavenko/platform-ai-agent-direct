# Sample: commit-push-bump-version

## Message

```
Harden tenant deploy SSE reconnect during long npm ci

Version: v1.0 (2)
```

## Commands

```bash
cd /path/to/platform-ai-agent-direct
COMMIT_MSG='Harden tenant deploy SSE reconnect during long npm ci' \
  bash .cursor/skills/commit-push-bump-version/scripts/validate.sh
bash .cursor/skills/commit-push-bump-version/scripts/bump-version.sh
# → name=1.0 code=2 label=v1.0 (2)
git add -A
git commit -m "$(cat <<'EOF'
Harden tenant deploy SSE reconnect during long npm ci

Version: v1.0 (2)
EOF
)"
git push origin HEAD
```
