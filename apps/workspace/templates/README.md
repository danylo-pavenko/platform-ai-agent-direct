# Tenant knowledge templates

Platform behaviour (Instagram webhooks, admin live chat, deploy) is documented in the **[repository root `README.md`](../../../README.md)**.

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
│   ├── sales-agent.txt
│   ├── leadgen-agent.txt
│   └── booking-agent.txt
└── knowledge/
    ├── brand.txt, contacts.txt, delivery.txt, faq.txt, categories.txt, services.txt
    ├── catalog.txt              # KeyCRM sync
    └── services-live.txt        # CleverBOX / BeautyPro sync
```

`catalog.txt` is never seeded — it is produced by the KeyCRM sync and
lives next to the other knowledge files so the prompt builder can
inject it.

## Customising per tenant

Just edit `/home/<user>/tenant_knowledge/knowledge/*.txt` or
`prompts/sales-agent.txt` directly. The next deploy will preserve the
edits. To re-seed a file from template, delete the tenant copy and run:

```bash
npm run bootstrap:knowledge
```
