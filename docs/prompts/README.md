# Local tenant prompts (gitignored)

Working copies of tenant system prompts live **here**. Git ignores `*.txt` in this folder — safe for brand facts, phones, and unfinished drafts.

## Naming

```text
docs/prompts/<tenant-slug>-system-prompt-v<major>.<minor>.txt
```

Examples:

- `docs/prompts/moxito-system-prompt-v1.19.txt`
- `docs/prompts/chip-tune-lviv-system-prompt-v1.0.txt`

## How to generate / improve

In Cursor, use the project skill **`tenant-first-prompt`** (`.cursor/skills/tenant-first-prompt/`):

- «Згенеруй перший промпт для тенанта …»
- «Покращ / онови промпт у docs/prompts/…»

The agent writes the `.txt` into this folder. Paste into Admin → Навчання агента when ready.

## Committed examples (read-only patterns)

Structure gold for **service** prompts may live under `scratch/moxito-system-prompt-v*.txt` in the repo — copy **patterns**, not business facts, into a new file here.
