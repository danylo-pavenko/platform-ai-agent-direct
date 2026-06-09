# IMPROVEMENTS.md

Майбутні покращення платформи, які **не входять** в базові MVP / v1 задачі
з `../IMPLEMENTATION.md`, але були обговорені з розробником і варті окремого
проходу. Кожен пункт — незалежний, порядок не обовʼязковий.

Статуси:
- `idea` — обговорювали, деталі не фіналізовано
- `planned` — домовились робити, чекає на слот
- `in-progress` — хтось робить
- `done` — зроблено, можна прибрати з файлу

---

## 1. CRM adapter + опційний MCP для KeyCRM

**Статус:** idea
**Обговорено:** 2026-04-21

**Контекст.** Зараз KeyCRM використовується у двох місцях:
- `sync-worker.ts` — batch ETL раз на 30 хв, генерує `catalog.txt`;
- `services/product-search.ts` — runtime lookup коли клієнт шерить IG-пост.

Було питання чи винести це на [`IvanKlymenko/keycrm-mcp`](https://github.com/IvanKlymenko/keycrm-mcp)
(обгортка KeyCRM в MCP-сервер).

**Рішення (попереднє).** MCP — overkill для поточної архітектури:
- ETL не виграє від MCP, тільки отримає +процес і +latency.
- Сторонній SDK додає dependency ризик (не офіційний Anthropic/KeyCRM).
- Runtime tool use з CRM у нас мінімальний (IG-пост → product-search).

**Що робити замість.**
1. Виділити `CrmAdapter` interface в `apps/backend/src/services/crm/`:
   ```ts
   interface CrmAdapter {
     fetchProducts(): Promise<Product[]>;
     fetchOffers(): Promise<Offer[]>;
     fetchCategories(): Promise<Category[]>;
     searchProducts(query: string): Promise<Product[]>;
     createOrder?(input: NewOrder): Promise<Order>; // v2
   }
   ```
2. `services/crm/keycrm.ts` — імплементація, просто переносимо існуючий код.
3. `services/crm/registry.ts` — `getCrmAdapter()` диспатчить по `CRM_PROVIDER`
   з `.env`. Зараз обидва клієнти на KeyCRM, але інтерфейс готовий.
4. Всі consumers (`sync-worker`, `product-search`, `telegram-bot`) звертаються
   через adapter, не через конкретний `keycrm.ts`.

**Коли повертатись до MCP.** Якщо вирішимо перевести Claude з "читає
статичний `catalog.txt`" на "дзвонить live CRM через tool-use на кожен
товарний запит" — тоді або ставимо `keycrm-mcp`, або загортаємо наш
`CrmAdapter` у власний MCP-сервер (adapter вже буде, 1-2 години роботи).

**Estimate.** Adapter refactor — ~2-3 години, без зміни поведінки, без ризику
для існуючих тенантів. MCP-шлях — окремий tracking коли буде потреба.

---

## 2. Індексація

> ⚠️ **Треба уточнити з розробником:** у нас двоїсте значення слова
> "індексація". Обидва варіанти нижче (2a і 2b) — legit, але дають різний
> ROI. Підтвердити який саме мався на увазі.

### 2a. DB-індекси (Prisma schema)

**Статус:** idea
**Контекст.** Таблиці `Message`, `Conversation`, `Client`, `Order` ростуть.
Найгарячіші queries:
- `/conversations?state=handoff` (admin list)
- `/conversations/:id/messages` (history fetch)
- `client.findUnique({ igUserId })` на кожен webhook
- Повнотекстовий пошук по messages (super-admin дашборд)

**Що робити.**
1. Пройтись по `schema.prisma`, додати composite indexes де потрібно:
   - `Message(conversationId, createdAt)` — для сортованого history
   - `Conversation(state, updatedAt DESC)` — для admin listу
   - `Client(igUserId)` — unique, але перевірити що є
   - `Order(status, createdAt DESC)` — для дашборда
2. Додати міграцію `add_perf_indexes`.
3. Після деплою — `EXPLAIN ANALYZE` гарячих queries на продакшен-DB,
   переконатись що індекси реально вибираються планувальником.
4. (Опційно) pg_trgm + GIN index для повнотекстового пошуку по
   `Message.content` якщо в super-admin зʼявиться "знайти розмову
   про X".

**Estimate.** ~2 години на pass + міграція. Безризиково (ADD INDEX не
блокує записи, CONCURRENTLY).

### 2b. Knowledge/Catalog RAG-індексація

**Статус:** idea
**Контекст.** Зараз Claude на кожне повідомлення отримує в промпт
**весь** `catalog.txt` (обрізаний до 6K chars) + `brand.txt`, `faq.txt`
і т.д. Це марнотратно: для питання "скільки коштує худі" не треба
показувати FAQ про доставку і весь каталог кепок/аксесуарів.

**Що робити.**
1. На першому етапі — **BM25** (lexical search) над chunks знань.
   Просто, без embeddings, без окремого сервісу. Бібліотека
   [`minisearch`](https://github.com/lucaong/minisearch) — 100% in-memory,
   підтримує stemming, prefix matching.
2. Chunk-стратегія: розбити кожен knowledge-файл на секції по заголовках
   `##`, по товарах у каталозі — по блоках `### {product}`.
3. На кожне повідомлення:
   - Беремо останні 2-3 user-turns як query.
   - Пошук → top-5 chunks.
   - Інжектимо тільки їх у промпт замість цілого `catalog.txt`.
4. Якщо BM25 дає false negatives (типу "є бежевий?" не знаходить "бежевий"
   у каталозі через стемінг української) — апгрейдимо на embeddings:
   - `pgvector` extension в Postgres (вже є у нас, просто `CREATE EXTENSION`)
   - Embeddings через Voyage-2 або OpenAI `text-embedding-3-small`
     (дешево, ~$0.02 на повний переіндекс каталогу)
   - Hybrid search: BM25 + cosine similarity

**Що це дає.**
- Коротший промпт → швидший response, дешевший Claude-call.
- Краща точність відповідей бо Claude бачить релевантне замість шуму.
- Відкриває шлях до мультитенантності по галузях (кожен тенант → свій
  індекс з власного `$HOME/tenant_knowledge`).

**Estimate.** BM25 варіант — ~1 день. Embeddings + pgvector — +1-2 дні.
Треба спершу виміряти: чи в нас зараз реальна проблема з точністю/
розміром промпта, чи це premature optimization.

---

## 3. Telegram: SLA-алерти, handoff і менеджерський UX

**Статус:** planned
**Обговорено:** 2026-06-09
**Аудит:** code review `telegram-bot.ts`, `telegram-notify.ts`, `conversation.ts`,
`brief.ts`, `order.ts`, `SettingsView.vue` (без live E2E на проді).

### Що вже працює (перевірено по коду, не E2E)

| Можливість | Файли | Примітка |
|------------|-------|----------|
| Свій bot token + manager group per tenant | `integration-config.ts`, Settings → Telegram | DB → `.env` fallback |
| PM2 `{ID}-bot` long polling | `telegram-bot.ts`, `ecosystem.config.cjs` | Без token — процес виходить з warn |
| Сповіщення: ескалація AI | `notifyHandoff` ← `request_handoff` | Причина + останні 5 msg |
| Сповіщення: замовлення | `notifyOrder` ← `order.ts` | Approve/decline → IG |
| Сповіщення: пресейл-бриф (leadgen) | `notifyBrief` ← `brief.ts` | Без зміни `state` |
| Сповіщення: CRM fallback | `notifyCrmFallback` ← `crm-sync.ts` | |
| Forward IG під час handoff | `conversation.ts` (state=handoff) | Див. п. 3.2 — спам |
| Takeover / return / close з TG | `telegram-bot.ts` | Inline + команди |
| Відповідь менеджера в IG з веб-адмінки | `routes/conversations.ts` POST `/:id/reply` | Не з TG |

### Що відсутнє (цілі з обговорення)

#### 3.1 SLA: «лід довго без відповіді» → ping у TG

**Контекст.** `managerSlaHoursBusiness` (Settings → Agent SLA) лише в промпті
(`{{MANAGER_SLA_HOURS}}`). Немає таймера, cron або повторних алертів.

**Що робити.**
1. Worker (cron кожні 15 хв або окремий PM2 job) — шукає кандидатів:
   - `state=handoff` + останнє вхідне від клієнта без відповіді менеджера
     довше N **робочих** годин (`working_hours` + `managerSlaHoursBusiness`);
   - опційно: `state=bot` + `firstInboundAt` без `firstOutboundAt` від менеджера
     (клієнт чекає на людину після ескалації).
2. `notifySlaBreach()` в `telegram-notify.ts` — коротка картка, без дублікатів
   (dedupe по `conversationId` + `slaAlertedAt` в DB або settings).
3. Health / dashboard: лічильник прострочених тредів.

**Estimate.** ~1–2 дні.

#### 3.2 Lightweight forward замість повної картки під handoff

**Контекст.** Кожне IG-повідомлення при `state=handoff` викликає повний
`notifyHandoff` (ескалація + 5 msg + кнопки) → спам у групі.

**Що робити.**
1. Розділити `notifyHandoff` (перша ескалація) і `notifyHandoffMessage`
   (короткий forward: `👤 @user: текст`).
2. Перша ескалація — повна картка; наступні — лише forward.

**Estimate.** ~2–4 години.

#### 3.3 Claude fallback (timeout/busy) → handoff + TG

**Контекст.** При `response.fallback` клієнт чує «менеджер відпише», але
`state` лишається `bot`, менеджери не отримують сповіщення.

**Що робити.**
1. У `conversation.ts` після `askClaude`: якщо `fallback` — опційно
   `state=handoff` + `notifyHandoff` з `reason: Claude timeout/busy`.
2. Feature flag у Settings (`auto_handoff_on_claude_error`).

**Estimate.** ~4 години.

#### 3.4 Підключити `handoff_keywords` і `auto_handoff` з Settings

**Контекст.** UI + seed зберігають ключові слова і прапорець, backend не читає.

**Що робити.**
1. Перед Claude (або після sanitize): regex/contains по `handoff_keywords`.
2. Якщо match + `auto_handoff` → той самий шлях, що `request_handoff`.

**Estimate.** ~4 години.

#### 3.5 `brief_hot:` callback + handoff після брифу

**Контекст.** Кнопка «Позначити hot» в `notifyBrief` — callback `brief_hot:`
не обробляється в `telegram-bot.ts`. Після `submit_brief` розмова лишається `bot`.

**Що робити.**
1. Handler `brief_hot:` — оновити `PresaleBrief.priority` / tag.
2. Опційно: після `submit_brief` → `state=handoff` + `notifyHandoff`
   («Новий лід, запит: …») для leadgen-режиму.

**Estimate.** ~0.5–1 день.

#### 3.6 Відповідь менеджера з Telegram → Instagram

**Контекст.** Менеджери бачать картки в групі, але відповідають лише через
веб-адмінку.

**Що робити.**
1. Reply на повідомлення бота в групі (або `/reply <convId> текст`) →
   `sendText` в IG + `Message` з `sender: manager`.
2. Привʼязка reply до `conversationId` через metadata в notify або quote.

**Estimate.** ~2–3 дні.

#### 3.7 Безпека takeover / approve в TG

**Контекст.** `/takeover`, approve/decline не перевіряють авторизацію;
`/login` привʼязує один `tgUserId` на admin record.

**Що робити.**
1. Inline callbacks — перевірка `ctx.from.id` у `admin_users.tg_user_id`
   або membership у manager group.
2. Multi-manager: окрема таблиця `manager_tg_links` замість одного поля.

**Estimate.** ~1 день.

#### 3.8 Мертвий код: `notifyError`, `notifyTokenExpiry`

**Контекст.** Функції є в `telegram-notify.ts`, ніде не викликаються.

**Що робити.**
1. `notifyError` — global error handler / Claude spawn failures.
2. `notifyTokenExpiry` — cron після перевірки IG token (Meta OAuth).

**Estimate.** ~0.5 дня.

#### 3.9 Health Check: валідація Telegram

**Контекст.** `health-check.ts` не перевіряє bot token / group id.

**Що робити.**
1. `getMe` + `getChat(managerGroupId)` у health-check.
2. Статуси: not_configured / error / ok (як Instagram).

**Estimate.** ~2–3 години.

#### 3.10 Уточнення: «meta-agent» vs sales agent

**Контекст.** Teach Chat (`routes/meta-agent.ts`) — редактор промпта, не handoff.
Передача ліда менеджерам — через **sales/leadgen** agent + `request_handoff` /
`submit_brief`. Окремий handoff з Teach Chat **не потрібен**, якщо не зміниться
продуктова вимога.

---

## 4. Claude auth через tenant admin (відкладено)

**Статус:** idea (відміна на 2026-06-09)
**Обговорено:** 2026-06-09

**Контекст.** Headless auth через `claude setup-token` → вставка
`CLAUDE_CODE_OAUTH_TOKEN` в Settings + pm2 restart. Не в пріоритеті.

**Що робити (коли повернутись).** Див. обговорення в чаті: `PUT /settings/claude/token`,
запис у `.env`, `restartTenantPm2()`, оновлення Health Check.

**Estimate.** ~4 дні MVP.

---

## 5. Інше (додавати сюди)

<!-- Коли зʼявиться нова ідея — додавай секцію за шаблоном:
## N. Назва
**Статус:** idea | planned | in-progress
**Обговорено:** YYYY-MM-DD

**Контекст.** ...
**Що робити.** ...
**Estimate.** ...
-->
