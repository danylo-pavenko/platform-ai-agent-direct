# Tenant knowledge templates

Platform behaviour (Instagram webhooks, Smart-trigger, Insights, admin live chat, deploy) is documented in the **[repository root `README.md`](../../../README.md)**.

## Runtime prompt architecture

| Layer | Source | Content |
|-------|--------|---------|
| Platform base | Backend code | Anti-injection, session (time, client, handoff), tools, live catalog |
| Tenant business | **Active system prompt (DB)** | Brand, contacts, delivery, FAQ, tone, sales rules |

`knowledge/*.txt` under `$TENANT_KNOWLEDGE_DIR` are **not injected** into Claude.
They may still exist as optional ops notes / migration leftovers. Put business
facts into the system prompt in Admin → Prompts.

## Disk layout (tenant home)

```
/home/<user>/tenant_knowledge/
├── CLAUDE.md                    # spawn orientation seed (not business facts)
├── prompts/                     # seed for first DB system_prompt only
│   ├── sales-agent.txt
│   ├── leadgen-agent.txt
│   └── booking-agent.txt
└── knowledge/
    ├── catalog.txt              # KeyCRM sync — injected as live snapshot
    ├── services-live.txt        # salon CRM sync (booking)
    └── (optional legacy txt)    # contacts/delivery/faq — NOT injected
```

### Runtime injection (sales / follow-up / sandbox)

1. Anti-injection preamble (platform)
2. **Active system prompt** from DB
3. Session block (time, hours, client, branches) + **catalog snapshot**
4. Mode-aware tools block (at Claude invoke)

Bootstrap still copies missing template files into the tenant dir and **never
overwrites** existing ones. New tenants should fill the system prompt in admin
(seeded once from `prompts/*-agent.txt`).
