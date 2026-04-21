# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Проєкт

**platform-ai-agent-direct** — AI Sales Agent для Instagram DM. Самостійна платформа, яку можна розгортати під різних клієнтів (перший клієнт: Status Blessed).

Мова спілкування з розробником: **українська**. Код, коміти, імена змінних: **англійська**.

## Критичні документи (рівнем вище)

Перед початком будь-якої роботи прочитай ці файли з батьківської директорії — вони містять повну специфікацію:

- `../IMPLEMENTATION.md` — **головний документ**. Покрокові задачі (34 шт, блоки A–H), .env reference, PM2 config, nginx, промпти, tool definitions, regression tests, захисти, multi-instance playbook. Реалізація іде саме за ним.
- `../PLAN.md` — архітектура верхнього рівня, модель даних (Prisma-схема), потоки (webhook → Claude → IG send), ризики. Дивись для загального контексту, але конкретні задачі — в IMPLEMENTATION.md.
- `../chatbase/00_system_prompt.txt` — повний системний промпт агента продажів (Version 3, українською). Це стартова seed-версія для таблиці `system_prompts`.
- `../chatbase/01_brand_and_voice.txt` — бренд, tone of voice, цінності → `apps/workspace/templates/knowledge/brand.txt`.
- `../chatbase/02_contacts_and_hours.txt` — контакти, графік → `apps/workspace/templates/knowledge/contacts.txt`.
- `../chatbase/03_delivery_and_payment.txt` — доставка, оплата → `apps/workspace/templates/knowledge/delivery.txt`.
- `../chatbase/06_faq.txt` — FAQ → `apps/workspace/templates/knowledge/faq.txt`.
- `../chatbase/04_categories.txt`, `../chatbase/05_catalog.txt` — каталог (генерується sync-воркером у `$HOME/tenant_knowledge/knowledge/catalog.txt`, не копіювати вручну).

**Важливо:** `apps/workspace/templates/` — це seed-набір, який шериться між усіма тенантами. Runtime-копію кожен тенант тримає у `$HOME/tenant_knowledge/` (або `TENANT_KNOWLEDGE_DIR` з `.env`). `deploy-client.sh` копіює відсутні файли templates → tenant dir, але ніколи не перезаписує існуючі.
- `../keycrm-openapi.yml` — OpenAPI spec KeyCRM (reference для написання KeyCRM client).
- `../data/` — JSON-дампи з KeyCRM (categories, products, offers). Git-ignored, для локальної розробки.
- `../products.csv` — повний експорт (788 варіантів). Для reference, не для коду.
- `../.env` — містить `KEYCRM_API_KEY` (НЕ комітити, НЕ читати вголос).

## Стек

- **Backend:** Node.js 20+ / TypeScript, Fastify, Prisma (PostgreSQL), Zod, Pino
- **Frontend (admin):** Vue 3, Vite, Vuetify 3, Pinia, Vue Router 4
- **Telegram bot:** grammY або Telegraf
- **Claude invocation:** Claude Code headless (SDK або CLI `claude -p`), НЕ Anthropic API
- **Process manager:** PM2 (prefix з INSTANCE_ID: `SB-api`, `SB-bot`, `SB-sync`, `SB-admin`)
- **Reverse proxy:** Nginx + Let's Encrypt

## Структура репо (цільова)

```
platform-ai-agent-direct/
├── apps/
│   ├── backend/         # Fastify + TS (PM2: SB-api, SB-bot, SB-sync)
│   ├── admin/           # Vue 3 + Vite (PM2: SB-admin)
│   └── workspace/       # Claude agent project dir (prompts, knowledge)
├── docs/
├── ecosystem.config.cjs
├── .env.example
└── package.json         # npm workspaces root
```

Повна структура — в `../IMPLEMENTATION.md` розділ 3.

## Порядок імплементації

Задачі виконувати **строго по порядку залежностей** з `../IMPLEMENTATION.md` розділ 8:

**MVP (бот відповідає в IG DM):** A.1 → A.2 → A.3 → B.2 → B.3 → C.1 → C.2 → C.3

**Повний v1:** + блоки D, E, F (KeyCRM sync, Telegram bot, Admin Vue).

**v2:** + блоки G, H (мета-агент, orders).

Перед кожною задачею — перечитай її опис та обмеження в IMPLEMENTATION.md.

## Конвенції коду

- **Не вигадуй фічі** поза задачами з IMPLEMENTATION.md.
- Імпорти: абсолютні з `@/` або відносні (не міксувати).
- Валідація вхідних даних: Zod schemas на кордонах (routes, webhooks). Внутрішні сервіси довіряють типам.
- Помилки: Fastify error handler + Pino. Не console.log.
- Env: читати через один `config.ts` який парсить `.env` через Zod і експортує типізований обʼєкт.
- Secrets: ніколи не логувати, не повертати в API responses.
- DB: Prisma міграції. Seed-скрипт для дефолтного admin user.
- Tests: Vitest. Мінімум — unit tests для sanitize, prompt-builder, ig-signature.

## Ключові обмеження (запамʼятати назавжди)

1. **Claude invocation = headless CLI/SDK, НЕ Anthropic API.** Не писати `anthropic.messages.create()`.
2. **Cross-conversation isolation:** Claude отримує ТІЛЬКИ messages поточної розмови. Ніколи не змішувати клієнтів.
3. **Prompt injection:** sanitize вхід (strip control chars), prompt structure (clear user/system separation), output validation (regex на product_id/purchased_price перед відправкою).
4. **Meta App = first-party (без App Review).** Власниця = App Owner = Page Admin.
5. **PM2 process names:** `{INSTANCE_ID.toUpperCase()}-api`, `-bot`, `-sync`, `-admin`.
6. **Домени SB:** `api.status-blessed.com` (backend), `agent.status-blessed.com` (admin Vue).
7. **Мова бота:** українська за замовчуванням. Код — англійська.
8. **Ціни 1₴** у категорії "Індивідуальне нанесення" — службові. Реальна вартість: принт 400–600₴, вишивка 1000–1500₴.
9. **Повернення/обмін** — політика не оприлюднена. Завжди ескалювати до менеджера.
10. **Max 30 повідомлень** в conversationHistory для Claude. Довші розмови — останні 30 + summary.
