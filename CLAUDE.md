# CLAUDE.md

Guidance for Claude Code / Cursor when working in **platform-ai-agent-direct**.

## Проєкт

Multi-tenant **Instagram DM AI agent** (sales / leadgen / booking). Кожен tenant = окремий Linux user + DB + `~/tenant_knowledge/`.

Мова з розробником: **українська**. Код / коміти: **англійська**.

## Що вже є (не вигадуй заново)

| Область | Де |
|---------|-----|
| Agent modes + tools | `apps/backend/src/lib/tool-definitions.ts`, `agent-tools-prompt.ts` |
| Multi-CRM | `docs/MULTI_CRM_INTEGRATION_GUIDE.md`, `services/crm/{keycrm,cleverbox,beautypro}.ts` |
| BeautyPro specifics | `.cursor/rules/beautypro-crm.mdc`, `docs/BEAUTYPRO_CRM_INTEGRATION.md` |
| Meta OAuth / IG DM | `.cursor/rules/meta-oauth-scopes.mdc` |
| Meta-agent (редактор промптів) | `routes/meta-agent.ts` + `lib/platform-capabilities-prompt.ts` |
| Tenant seed knowledge | `apps/workspace/templates/` → bootstrap у `$TENANT_KNOWLEDGE_DIR` |
| IG webhook routing case | `.cursor/rules/instagram-webhook-routing-case.mdc` |

**Claude invocation = headless CLI/SDK, НЕ Anthropic Messages API.**

## Tenant CLAUDE.md vs цей файл

| Файл | Для кого |
|------|----------|
| **Цей** `CLAUDE.md` (корінь репо) | Розробник / coding agent у репозиторії |
| `apps/workspace/templates/CLAUDE.md` | Орієнтир у tenant knowledge (режими/tools); seed, не перезаписує існуючий |

Мета-агент **не читає** файли з диска як єдине джерело — йому вшивається `<platform_capabilities>` з коду. Оновлюючи tools/CRM — синхронно оновлюй `platform-capabilities-prompt.ts` і template `CLAUDE.md`.

## Документація в репо

- `README.md`, `docs/MULTI_CRM_INTEGRATION_GUIDE.md`, `docs/BEAUTYPRO_CRM_INTEGRATION.md`
- Seed prompts: `apps/workspace/templates/prompts/{sales,leadgen,booking}-agent.txt`
- Батьківські `../IMPLEMENTATION.md` / `../PLAN.md` — історичний контекст MVP; **поточна правда — код + docs/ у цьому репо**.

## Конвенції

- Не фічі поза задачею; Zod на boundaries; Pino, не console.log; secrets не в логах/API.
- CRM лише через `getCrmAdapter` + `resolveCrmProvider(action)` — не HTTP клієнт у `conversation.ts`.
- Meta scopes: тільки ті, що в `.cursor/rules/meta-oauth-scopes.mdc`.
- Філії runtime = таблиця `branches`; CRM = джерело імпорту.

## Ключові обмеження

1. Cross-conversation isolation (макс. ~30 msgs історії).
2. Не світити product/offer/CRM ids клієнту.
3. PM2: `{INSTANCE_ID}-api|bot|sync|admin`.
4. Knowledge: templates seed → tenant dir, deploy не overwrite existing.
