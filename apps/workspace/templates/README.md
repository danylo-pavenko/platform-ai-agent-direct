# Tenant knowledge templates

Platform behaviour (Instagram webhooks, Smart-trigger, Insights, admin live chat, deploy) is documented in the **[repository root `README.md`](../../../README.md)**.

This folder is the **seed set** that every new tenant starts with. It is
checked into the repo and shared across all tenants. Individual tenants
never edit these files directly — they edit their own copy in their
Linux user's home, at `$HOME/tenant_knowledge/` (configurable via the
`TENANT_KNOWLEDGE_DIR` env var).

## How it works

On each deploy, `bootstrap-tenant-knowledge` is run. For every file
under `templates/` it:

- If the file does **not** exist in `$TENANT_KNOWLEDGE_DIR` → **copy** it.
- If the file **already** exists → **leave it alone** (tenant edits win).

So tenants get a smart default out of the box, and retain full control
afterward — subsequent deploys never overwrite customer edits.

## Runtime layout

For a tenant running as Linux user `blessed` with the default path:

```
/home/blessed/tenant_knowledge/
├── CLAUDE.md                    # орієнтир режимів/tools (seed)
├── prompts/
│   ├── sales-agent.txt          # mode: sales
│   ├── leadgen-agent.txt        # mode: leadgen
│   └── booking-agent.txt        # mode: booking
└── knowledge/
    ├── brand.txt, contacts.txt, delivery.txt, faq.txt, categories.txt, services.txt
    ├── catalog.txt              # KeyCRM sync (not seeded)
    └── services-live.txt        # CleverBOX / BeautyPro sync (not seeded)
```

`catalog.txt` / `services-live.txt` are never seeded — they are produced by
CRM sync and live next to the other knowledge files so the prompt builder
can inject them.

### Runtime injection (sales / follow-up / sandbox)

On each Claude turn the prompt builder loads:

1. **Active system prompt** from DB (seeded once from `prompts/sales-agent.txt`).
2. **KNOWLEDGE PACK** — `knowledge/{brand,contacts,delivery,faq,categories}.txt`
   concatenated into the session block (per-file / pack size caps).
3. **Catalog snapshot** — live `catalog.txt` (or empty until CRM sync).

Fill the TODO stubs in knowledge files during onboarding. Empty or TODO
lines mean the agent must escalate — not invent facts. Existing tenants
keep their copies: bootstrap never overwrites `$TENANT_KNOWLEDGE_DIR`.

Tone of voice and sales rules in these prompts also shape **Smart-trigger**
remarketing: the follow-up job reuses the same system prompt + conversation
history (no separate reminder template).

## Customising per tenant

Just edit `/home/<user>/tenant_knowledge/knowledge/*.txt` or
`prompts/{sales|leadgen|booking}-agent.txt` directly. The next deploy will
preserve the edits. To re-seed a file from template, delete the tenant copy
and run:

```bash
npm run bootstrap:knowledge
```
