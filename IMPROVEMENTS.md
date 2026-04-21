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

## 3. Інше (додавати сюди)

<!-- Коли зʼявиться нова ідея — додавай секцію за шаблоном:
## N. Назва
**Статус:** idea | planned | in-progress
**Обговорено:** YYYY-MM-DD

**Контекст.** ...
**Що робити.** ...
**Estimate.** ...
-->
