---
name: commit-push-bump-version
description: >-
  For platform-ai-agent-direct only: bump VERSION.json (code +1 every commit;
  name every 10 codes), commit all changes, and push. Use when the user asks
  to commit/push with version bump, /commit-push-bump-version, or to release
  a new platform build number.
disable-model-invocation: true
---

# Commit, bump version, and push (this repo only)

## When to use

Apply in **platform-ai-agent-direct** when the user wants to commit and push **and**
advance the platform version (`VERSION.json`). Prefer this over generic `commit-git`
for release-facing work in this project.

## Version rules

Source of truth: [`VERSION.json`](../../../VERSION.json) at repo root.

| Field | Rule |
|-------|------|
| `code` | Integer build number — **+1 on every** bump |
| `name` | Marketing version (`1.0`, `1.1`, …) — **+0.1 every 10 codes** (when `code % 10 === 0`) |

Display label everywhere: `v{name} ({code})` e.g. `v1.0 (9)`, then next bump at code 10 → `v1.1 (10)`.

Bump script: [scripts/bump-version.sh](scripts/bump-version.sh) (also syncs root `package.json` `version` to `{name}.{code}`).

## Workflow

1. **Context**: From repo root, run `git status`, `git diff`, `git log -5 --oneline`.
2. **Draft message**: Concise English imperative (what/why). Do not put secrets in the message.
3. **Validate**:
   ```bash
   COMMIT_MSG='your message' bash .cursor/skills/commit-push-bump-version/scripts/validate.sh
   ```
4. **Bump** (before staging so VERSION.json is included):
   ```bash
   bash .cursor/skills/commit-push-bump-version/scripts/bump-version.sh
   ```
5. **Commit + push** (sequential):
   ```bash
   git add -A
   git commit -m "$(cat <<'EOF'
   <message>

   Version: v<name> (<code>)
   EOF
   )"
   git push origin HEAD
   git status
   ```
   Fill `<name>` / `<code>` from the bump script stdout (`label=v…`).

## Safety

- Never force-push or rewrite history unless the user explicitly asks.
- Do not commit `.env` or secrets.
- If validate fails (clean tree / empty message), stop and report.
- This skill is **project-scoped**; do not run the bump script in other repos.

## Files

| Path | Role |
|------|------|
| [scripts/bump-version.sh](scripts/bump-version.sh) | Increment code / maybe name |
| [scripts/validate.sh](scripts/validate.sh) | Pre-flight before commit |
| [examples/sample.md](examples/sample.md) | Example message + commands |
