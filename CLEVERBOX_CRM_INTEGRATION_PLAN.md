# CleverBOX CRM — план інтеграції

**Контекст.** Платформа вже має інтеграцію з KeyCRM (e-commerce: каталог, замовлення, ліди).
Наступний сегмент клієнтів — салони краси, SPA, масажні салони. Більшість з них
користуються [CleverBOX CRM](https://cleverbox-crm.com/) (хостинг API: `cbox.mobi`).

**Мета документа:** зафіксувати аналіз REST API CleverBOX, архітектурні рішення для
**мульти-CRM** (KeyCRM + CleverBOX паралельно) і покроковий план імплементації в агенті —
без ламання існуючих e-commerce tenant'ів.

**Джерела:**
- Swagger: [cbox.mobi/doc/rest](https://cbox.mobi/doc/rest/#/) (оновлення 23.02.2026)
- Розширений опис: [Google Doc (CleverBOX)](https://docs.google.com/document/d/1cpImjGE4tfmgAJSMVV0f6KVKROtw_1Ly-3lT6KncBXI/edit)
- Поточна CRM-абстракція: `apps/backend/src/services/crm/types.ts`, `registry.ts`

---

## Статус реалізації (2026-07-06, оновлено)

### ✅ Phase 1 — Foundation (DONE + hardened)

| Компонент | Статус |
|-----------|--------|
| Schema | `Branch`, `ClientReferencePhoto`, `Appointment`, `crm_sync_runs`, `Conversation.branchId` |
| Branches API + admin | CRUD, CRM import, `BranchesCard` |
| Reference photos | `tenant_knowledge/reference_photos/`, API + `/reference-photos/file/*` |
| Branch runtime | `set_conversation_branch` tool, prompt injection `{{BRANCHES_LIST}}`, selected branch in session |
| Settings nav | Sticky sidebar, SyncView CRM columns |

### ✅ Phase 2 — CleverBOX adapter (DONE)

| Компонент | Статус |
|-----------|--------|
| `cleverbox.ts` | filials, services, slots/get, slots/save (v3) |
| `integration_cleverbox` | DB + env + `CleverboxCard` admin |
| Sync | `services-live.txt` when token configured |
| Multi-provider registry | `getCrmAdapter(name)`, per-provider cache |

### ✅ Phase 3 — Booking mode (DONE)

| Компонент | Статус |
|-----------|--------|
| `agent_mode=booking` | admin + `agent-config.ts` |
| Tools | `search_services`, `get_available_slots`, `book_appointment`, `attach_reference_photo` |
| `Appointment` model | + `mirrorAppointmentToCrm` |
| Seed prompt | `booking-agent.txt` |

### ✅ Phase 4 — CRM routing (DONE)

| Компонент | Статус |
|-----------|--------|
| `crm_routing` setting | `single` / `by_action` / `prompt` |
| `resolveCrmProvider(action)` | catalog, services, booking, branches, order, lead |
| Tool `crm_provider` arg | booking tools (validated against enabled providers) |
| Admin `CrmRoutingCard` | Settings → CRM routing |
| `CleverboxCard` + agent mode `booking` | інтеграції + агент |

### 🕐 Phase 5 — Polish (NEXT)

- `Appointment` list in admin
- Auto-import branches on sync
- PoC з реальним CleverBOX token
- Unit tests для adapters / routing

---

## Архітектура multi-CRM (extensibility)

```
                    ┌─────────────────┐
                    │  crm_routing    │  settings (mode, routes, enabled)
                    └────────┬────────┘
                             │
              resolveCrmProvider(action, toolArgs?)
                             │
         ┌───────────────────┼───────────────────┐
         ▼                   ▼                   ▼
   keycrmAdapter      cleverboxAdapter     [future CRM]
   capabilities       capabilities
   catalog/orders     services/booking
```

**Додати нову CRM:** реалізувати `CrmAdapter` + `capabilities` + зареєструвати в `registry.ts` + додати в `CRM_PROVIDER_NAMES` + секція в адмінці.

**Філії:** завжди в нашій таблиці `branches` — CRM лише джерело імпорту (`crmExternalId`). Runtime не залежить від CRM для вибору локації.

---

## Статус реалізації (архів — первинний Phase 1)

| Компонент | Що зроблено |
|-----------|-------------|
| **Schema** | `Branch`, `ClientReferencePhoto`, `Conversation.branchId`, `crm_sync_runs` (+ provider/syncType/artifacts) |
| **Branches API** | `GET/POST/PUT/DELETE /branches`, `GET /branches/crm-candidates`, `POST /branches/import-from-crm` |
| **Reference photos** | `$HOME/tenant_knowledge/reference_photos/`, `POST/GET /reference-photos/client/:id` |
| **Sync metadata** | Worker пише `provider`, `syncType`, `artifacts.sources` у `crm_sync_runs` |
| **Admin: Settings** | Бічна навігація (sticky), секція «Філії» (`BranchesCard.vue`) |
| **Admin: Sync** | Колонки CRM / тип / джерела / файли, summary cards |

**Міграція:** `20260706180000_branches_crm_sync_reference_photos`

### 🕐 Phase 2 — CleverBOX adapter (NEXT)

CleverBOX HTTP client, `fetchBranches`, `fetchServices`, sync `services-live.txt`.

### 🕐 Phase 3 — Booking mode + tools

`agent_mode=booking`, `search_services`, `get_available_slots`, `book_appointment`, `attach_reference_photo`.

### 🕐 Phase 4 — Multi-CRM routing + prompt rules

`crm_routing` setting, `resolveCrmProvider()`, prompt injection `{branches}` + `{crm_routing_rules}`.

---

## Модель філій (архітектура)

Одна IG-сторінка → кілька фізичних локацій. Бот **перепитує локацію** (логіка в системному промпті).

| Поле | Призначення |
|------|-------------|
| `slug` | Внутрішній ключ для агента (`obolon`, `center`) |
| `displayName` | Зовнішня назва для клієнта |
| `keywords` | Розпізнавання в повідомленні («Оболонь», «ТЦ Дрім») |
| `address` | Опційно, показується клієнту |
| `crmExternalId` | `salon_id` CleverBOX після імпорту |
| `source` | `manual` \| `crm` |

Імпорт з CRM **не перезаписує** slug/keywords — лише `displayName`, `address`, `crmSyncedAt`.

Плейсхолдер у промпті: `formatBranchesForPrompt()` → список активних філій.

## Reference photos

Шлях: `{TENANT_KNOWLEDGE_DIR}/reference_photos/{clientId}/{yyyy}/{mm}/{uuid}.ext`

- Зовні git (на Linux user tenant'а)
- Копія з IG `uploads/` при виклику tool / admin API
- MVP для CRM: URL у `comment` візиту CleverBOX; upload API — Phase 2 discovery

---

## 1. Висновки з аналізу CleverBOX API

### 1.1. Загальні параметри

| Параметр | Значення |
|----------|----------|
| Base URL (read) | `https://cbox.mobi/api/v2/rest` |
| Base URL (booking write) | `https://cbox.mobi/api/v3/rest` — `slots/save`, `slots/cancel` |
| Авторизація | HTTP header `token: <API_KEY>` |
| Формат | JSON, усі методи **POST** |
| Отримання токена | CleverBOX → Налаштування → API → створити користувача (email + пароль → token) |

### 1.2. Релевантні ендпоінти для агента

| Група | Endpoint | Призначення для агента |
|-------|----------|------------------------|
| **filials** | `POST /filials` | Список філій салону (мульти-локація) |
| **services** | `POST /services` | **Каталог послуг**: назва, ціна, тривалість, категорія, ціни по філіях |
| **slots** | `POST /slots/get` | Вільні слоти + список майстрів на дату |
| **slots** | `POST /slots/save` (v3) | **Створення запису** (візит) |
| **slots** | `POST /slots/cancel` (v3) | Скасування / перенесення |
| **clients** | `POST /clients/search` | Пошук клієнта за телефоном (≥4 цифри) |
| **clients** | `POST /clients/visits` | Майбутні візити клієнта |
| **visits** | `POST /visits` | Список візитів (аналітика / перевірка) |
| **products** | `POST /products/list` | Товари (додатково, якщо салон продає косметику) |

### 1.3. Модель послуги (`ServiceItem`)

Ключові поля з swagger:

```
id, name, check_name, price, time (хв),
category_id, category_name, direct_id, direct_name,
prices[] → { salon_id, salon_name, price }  // ціна по філії
```

Це **не** товар з варіантами (як KeyCRM offer), а послуга з тривалістю та опційною ціною по філії.

### 1.4. Запис на прийом (`slots/save`)

Запит (v3):

```json
{
  "date": "03.07.2026",
  "salon_id": 114,
  "client_id": 0,
  "name": "Олена",
  "phone": "380971234567",
  "comment": "Фото кольору в коментарі / посилання",
  "services": [
    {
      "id": 45,
      "long": 60,
      "master_id": 7,
      "time": "09:00"
    }
  ]
}
```

Поведінка (з документації):
- `client_id = 0` → пошук за `phone`; якщо не знайдено — **автостворення** клієнта.
- Відповідь: `record_id`, `comment`, опційно `invoice.link` (оплата онлайн).

### 1.5. Слоти (`slots/get`)

Запит: `date`, `salon_id`, `all` (місяць), `services[]` з `id` + `long`.

Відповідь: по днях масив `{ on, time, masters[] }` + довідник `{ id, name }` майстрів.
Агент може пропонувати час **і** конкретного майстра (`master_id` у `slots/save`).

### 1.6. Що API **не** документує (ризик)

| Потреба | Статус у публічному swagger |
|---------|----------------------------|
| Завантаження фото в картку клієнта | **Немає** endpoint |
| Оновлення клієнта (PATCH) | **Немає** — лише search + автостворення при записі |
| Список майстрів окремо | Лише через `slots/get` → `masters` |
| Webhook при зміні запису | **Немає** |

Модель `File` є у swagger, але прив'язана до **товару** (`ProductItem.files`), не до клієнта.
У UI CleverBOX фото в картці клієнта підтримуються, але REST для upload **потрібно уточнити
у підтримки CleverBOX** (див. Phase 0).

### 1.7. CleverBOX vs KeyCRM — різні домени

| | KeyCRM (зараз) | CleverBOX (ціль) |
|--|----------------|------------------|
| Основна сутність | Товар / offer / замовлення | Послуга / візит / запис |
| Каталог | `fetchProducts` + `fetchOffers` | `POST /services` |
| Створення угоди | `createOrder`, `createLead` | `slots/save` (візит) |
| Доставка НП | Так | Ні |
| Майстер / слот | Ні | Так |
| Pipeline / лід | Так | Ні (є `comment` на візиті) |

**Висновок:** не варто натягувати CleverBOX на існуючий `CrmProduct`/`collect_order` без
окремого режиму агента. Потрібен **`booking`-mode** + розширення адаптера.

---

## 2. Цільовий UX агента (салон краси)

1. Клієнт пише в IG DM: «Хочу фарбування, є фото волосся» + надсилає фото.
2. Агент:
   - знаходить послуги з каталогу (назва, ціна, тривалість);
   - уточнює філію / майстра (якщо кілька);
   - показує вільні слоти (`slots/get`);
   - підтверджує запис → `book_appointment` → CleverBOX `slots/save`;
   - фото: зберігає локально + додає посилання в `comment` візиту (MVP);
     після Phase 0 — прикріплення в CRM, якщо API з'явиться.
3. Менеджер бачить запис у CleverBOX + Telegram-нотифікацію з нашого бекенду.

Паралельно e-commerce tenant (Status Blessed) продовжує працювати через KeyCRM без змін.

---

## 3. Архітектурні рішення

### 3.1. Зберегти `CrmAdapter`, розширити контракт

Поточний інтерфейс (`apps/backend/src/services/crm/types.ts`) орієнтований на e-commerce.
Додаємо **опціональні** методи для booking-провайдерів:

```typescript
// Нові типи (ескіз)
interface CrmServiceItem {
  id: number;
  name: string;
  price: number;
  durationMin: number;
  categoryName?: string;
  branchPrices?: Array<{ branchId: string; branchName: string; price: number }>;
}

interface CrmSlotQuery {
  date: string;       // DD.MM.YYYY
  branchId: string;
  services: Array<{ id: number; durationMin: number }>;
  fullMonth?: boolean;
}

interface CrmSlot {
  date: string;
  time: string;       // HH:MM
  masterIds: string[];
}

interface CrmBookingInput {
  date: string;
  branchId: number;
  clientId?: number;
  clientName: string;
  phone: string;
  comment?: string;
  services: Array<{
    id: number;
    durationMin: number;
    masterId?: number;
    startTime: string;
  }>;
}

interface CrmAdapter {
  // ... існуючі read/write ...

  // Booking (optional — CleverBOX: так, KeyCRM: omit)
  fetchServices?(params?: { categoryId?: number }): Promise<CrmServiceItem[]>;
  fetchBranches?(): Promise<Array<{ id: string; name: string }>>;
  getAvailableSlots?(query: CrmSlotQuery): Promise<{
    slots: Record<string, CrmSlot[]>;
    masters: Array<{ id: string; name: string }>;
  }>;
  createBooking?(input: CrmBookingInput): Promise<{
    crmRecordId: string;
    comment?: string;
    paymentLink?: string;
  }>;
  cancelBooking?(recordId: number, reason?: 'move' | 'cancel'): Promise<void>;
  attachClientMedia?(clientId: number, payload: {
    url: string;
    filename: string;
    note?: string;
  }): Promise<{ fileId?: string }>;
}
```

KeyCRM-адаптер **не реалізує** booking-методи — consumers перевіряють наявність.

### 3.2. Мульти-CRM: три рівні вибору провайдера

Замість одного `CRM_PROVIDER` env — **матриця маршрутизації**:

#### Setting `crm_routing` (JSON у `settings`)

```json
{
  "mode": "by_action",
  "default": "keycrm",
  "routes": {
    "catalog": "keycrm",
    "order": "keycrm",
    "lead": "keycrm",
    "booking": "cleverbox",
    "client_upsert": "cleverbox"
  },
  "enabled_providers": ["keycrm", "cleverbox"]
}
```

| `mode` | Поведінка |
|--------|-----------|
| `single` | Один провайдер (як зараз `CRM_PROVIDER`) — backward compatible |
| `by_action` | Кожна CRM-операція йде за `routes.*` |
| `prompt` | Агент передає `crm_provider` у tool args; бекенд валідує проти `enabled_providers` + optional allowlist у системному промпті |

#### Промпт-керований вибір (не жорстко в коді)

У системному промпті tenant'а (секція «CRM routing rules»):

```
- Запис на послугу / візит → cleverbox (book_appointment)
- Покупка товарів з доставкою → keycrm (collect_order)
- Пресейл-бриф без запису → keycrm (submit_brief)
```

Бекенд:
1. Tool schema містить optional `crm_provider?: 'keycrm' | 'cleverbox'`.
2. Якщо `crm_routing.mode === 'prompt'` і поле передано — використовуємо його (з валідацією).
3. Якщо не передано — fallback на `routes` / `default`.
4. Системний промпт — **джерело бізнес-правил**; код лише enforce безпеки.

### 3.3. Registry: `getCrmAdapter(provider?)`

```typescript
getCrmAdapter(provider?: CrmProviderName): CrmAdapter;
resolveCrmProvider(action: CrmAction, toolArgs?: { crm_provider?: string }): CrmProviderName;
```

Кеш: один інстанс на провайдер (не singleton один на весь процес).

### 3.4. Новий agent mode: `booking`

Розширити `agent_mode`: `sales` | `leadgen` | **`booking`**.

| Tool | sales | leadgen | booking |
|------|-------|---------|---------|
| `update_client_info` | ✓ | ✓ | ✓ |
| `tag_client` | ✓ | ✓ | ✓ |
| `request_handoff` | ✓ | ✓ | ✓ |
| `classify_intent` | ✓ | ✓ | ✓ |
| `collect_order` | ✓ | — | —* |
| `search_catalog` | ✓ | — | — |
| `get_delivery_cost` | ✓ | — | — |
| `submit_brief` | — | ✓ | — |
| **`search_services`** | — | — | ✓ |
| **`get_available_slots`** | — | — | ✓ |
| **`book_appointment`** | — | — | ✓ |
| **`attach_reference_photo`** | — | — | ✓ |

\* У `crm_routing.mode=by_action` салон може мати **гібрид**: запис через CleverBOX,
продаж товарів через KeyCRM — тоді `collect_order` лишається в tool set, але промпт
обмежує коли його викликати.

### 3.5. Локальна модель `Appointment` (не reuse `Order`)

`Order` жорстко прив'язаний до НП / payment_method — не підходить для візиту.

Нова модель:

```prisma
model Appointment {
  id              String   @id @default(uuid())
  conversationId  String
  clientId        String
  branchId        String?          // CleverBOX salon_id
  services        Json             // [{ id, name, price, durationMin, masterId?, startTime }]
  scheduledDate   String           // DD.MM.YYYY
  scheduledTime   String           // HH:MM
  customerName    String
  phone           String
  comment         String?
  referencePhotos Json?            // [{ storageKey, publicUrl }]
  status          AppointmentStatus @default(draft)
  crmProvider     String           // cleverbox
  crmRecordId     String?          // record_id з slots/save
  crmSyncStatus   CrmSyncStatus
  crmSyncError    String?
  crmSyncedAt     DateTime?
  createdAt       DateTime @default(now())
}
```

Поле `keycrmOrderId` в `Order` **не перейменовуємо** в Phase 1 (backward compat).
Для нових сутностей — generic `crmProvider` + `crmRecordId`.

### 3.6. Knowledge sync: `services.txt` замість `catalog.txt`

Для `booking`-mode sync-worker:
1. `POST /services` (пагінація `offset`, limit=100) → `tenant_knowledge/knowledge/services-live.txt`
2. Формат для Claude (аналог catalog.txt):

```
[service_id=45] Фарбування коріння | 120 хв | від 800 ₴ | Категорія: Фарбування
[service_id=82] Стрижка жіноча | 60 хв | 450 ₴ | Майстри: через slots
```

Окремий sync run table або розширити `keycrm_sync_runs` → `crm_sync_runs` (generic).

### 3.7. Integration config

Новий ключ `integration_cleverbox` у `settings`:

```typescript
interface IntegrationCleverbox {
  apiToken: string;
  defaultBranchId: string;      // salon_id за замовчуванням
  syncIntervalMin: number;
  appUrl: string;               // deep link base, якщо є
  slotsApiVersion: 'v3';        // зафіксовано
}
```

Обидва провайдери можуть бути заповнені одночасно в адмінці.

### 3.8. Фото від клієнта (MVP → повна інтеграція)

**MVP (Phase B):**
1. IG webhook вже зберігає `mediaAttachments` + storage keys.
2. Tool `attach_reference_photo` прив'язує фото до `Appointment.referencePhotos`.
3. При `mirrorAppointmentToCrm`: публічний signed URL (або наш CDN) додається в `comment`
   візиту CleverBOX + Telegram менеджеру з прев'ю.

**Phase 0 / post-MVP:**
- Запит до CleverBOX support про endpoint upload до картки клієнта.
- Якщо API з'явиться — реалізувати `attachClientMedia` в адаптері.

---

## 4. Покроковий план імплементації

### Phase 0 — Discovery (1–3 дні, до коду)

| # | Задача | Вихід |
|---|--------|-------|
| 0.1 | Отримати тестовий CleverBOX акаунт + API token | `.env` на dev |
| 0.2 | PoC curl: `/services`, `/filials`, `/slots/get`, `/slots/save` | `docs/cleverbox-poc.md` з прикладами request/response |
| 0.3 | Уточнити у CleverBOX: upload фото до client card, rate limits, sandbox | Ticket / відповідь support |
| 0.4 | Перевірити чи v2 token працює на v3 slots | Нотатка в poc |
| 0.5 | Визначити 1 пілотного tenant (1 філія, 5–10 послуг) | Ім'я в IMPLEMENTATION tracker |

**Gate:** PoC створює тестовий запис і читає каталог — інакше не йдемо в Phase A.

---

### Phase A — CRM adapter + config (≈3–5 днів)

| # | Задача | Файли / зміни |
|---|--------|---------------|
| A.1 | `cleverbox.ts` HTTP client: `cboxJson(method, path, body, { apiVersion })`, header `token` | `apps/backend/src/services/crm/cleverbox.ts` |
| A.2 | Реалізувати `cleverboxAdapter` з booking-методами | там же |
| A.3 | Розширити `CrmAdapter` types (секція 3.1) | `crm/types.ts` |
| A.4 | `registry.ts`: `cleverbox`, `getCrmAdapter(name)`, `resolveCrmProvider` | `crm/registry.ts` |
| A.5 | `integration_cleverbox` у `integration-config.ts` + env `CLEVERBOX_API_TOKEN`, `CLEVERBOX_DEFAULT_BRANCH_ID` | config, settings route |
| A.6 | Setting `crm_routing` + reader `getCrmRouting()` | `lib/crm-routing.ts` |
| A.7 | Health check: CleverBOX `/filials` ping | `health-check.ts` |
| A.8 | Unit tests: parse `ServiceItem`, slot response mapping | `cleverbox.test.ts` |

**Вихід:** з CLI/тестів можна витягнути послуги і створити запис без агента.

---

### Phase B — Booking mode + tools (≈5–7 днів)

| # | Задача | Файли |
|---|--------|-------|
| B.1 | Prisma: `Appointment`, enum `AppointmentStatus`, міграція | `schema.prisma` |
| B.2 | `agent_mode=booking` у settings + seed `booking-agent.txt` | templates, deploy-client.sh |
| B.3 | Tools: `search_services`, `get_available_slots`, `book_appointment`, `attach_reference_photo` | `tool-definitions.ts` |
| B.4 | Handlers у `conversation.ts` / новий `appointment.ts` | services |
| B.5 | `mirrorAppointmentToCrm` (аналог `mirrorOrderToCrm`) | `crm-sync.ts` |
| B.6 | Telegram notify: новий запис + фото | `telegram-notify.ts` |
| B.7 | Prompt builder: booking placeholders (філії, політика скасування) | `prompt-builder.ts` |
| B.8 | Admin: список appointments (мінімум — таблиця + CRM link) | новий view або розділ Orders |

**Вихід:** бот у booking-mode веде діалог і створює візит у CleverBOX.

---

### Phase C — Catalog sync + multi-CRM routing (≈3–4 дні)

| # | Задача |
|---|--------|
| C.1 | Sync-worker: гілка для CleverBOX → `services-live.txt` |
| C.2 | `search_services` tool: live API з fallback на файл |
| C.3 | Admin Settings: секція CleverBOX (token, branch, test connection) |
| C.4 | Admin Settings: CRM routing UI (`mode`, `routes`, enabled providers) |
| C.5 | Документація в системному промпті tenant: шаблон «CRM routing rules» |
| C.6 | `crm-sync` / `product-search`: `resolveCrmProvider('catalog')` |

**Вихід:** tenant налаштовує обидві CRM; маршрутизація з адмінки + промпта.

---

### Phase D — Hybrid & hardening (≈3–5 днів)

| # | Задача |
|---|--------|
| D.1 | Гібридний tool set (booking + collect_order) при `enabled_providers: [both]` |
| D.2 | Скасування / перенесення: tool `reschedule_appointment` → cancel v3 + save v3 |
| D.3 | `clients/search` перед записом → зберегти `client.crmBuyerId` (CleverBOX client id) |
| D.4 | Retry queue для failed appointment mirror (reuse `crm-mirror-retry`) |
| D.5 | Rate limiting / cache слотів (5 хв TTL на `slots/get` для однакового запиту) |
| D.6 | Regression: Status Blessed (KeyCRM only) — zero diff у sales-mode |

---

### Phase E — Фото в CRM (залежить від Phase 0)

| # | Задача |
|---|--------|
| E.1 | Якщо CleverBOX дає upload API — `attachClientMedia` |
| E.2 | Інакше: менеджерський workflow «прикріпити з Telegram» (deep link) |
| E.3 | Опційно: проксі-upload через наш backend → CleverBOX |

---

## 5. Зміни в адмінці (зведено)

### Settings → Інтеграції

- **KeyCRM** — без змін (apiKey, sourceId, appUrl).
- **CleverBOX** (нове): API token, default branch, sync interval, «Перевірити з'єднання».
- **CRM маршрутизація** (нове):
  - Режим: один провайдер / за типом дії / за промптом агента
  - Таблиця: Каталог | Замовлення | Лід | Запис | Клієнт → dropdown провайдера
  - Чекбокси enabled providers

### Agent mode

Dropdown: `Продажі (sales)` | `Лідоген (leadgen)` | `Запис (booking)` | `Гібрид (hybrid)`*

\* `hybrid` = booking tools + collect_order, маршрутизація через `crm_routing`.

---

## 6. Зміни в workspace / промптах

Нові templates:

```
apps/workspace/templates/prompts/booking-agent.txt
apps/workspace/templates/knowledge/salon-policies.txt   # скасування, депозит, запізнення
apps/workspace/templates/knowledge/branches.txt         # адреси філій (override з API)
```

Секція в кожному промпті:

```
## CRM routing (tenant-specific)
{crm_routing_rules}
```

Плейсхолдер інʼєктиться з settings `crm_routing_prompt_rules` (markdown, редагується в адмінці).

---

## 7. Env reference (додатково до `.env.example`)

```bash
# CleverBOX CRM (beauty / spa / massage)
CLEVERBOX_API_TOKEN=
CLEVERBOX_DEFAULT_BRANCH_ID=
CLEVERBOX_SYNC_INTERVAL_MIN=60

# Multi-CRM (опційно; per-tenant у settings пріоритетніше)
CRM_ROUTING_MODE=single          # single | by_action | prompt
CRM_ROUTING_DEFAULT=keycrm
```

Існуючий `CRM_PROVIDER` лишається для backward compat (`mode=single`).

---

## 8. Ризики та мітигація

| Ризик | Імовірність | Мітигація |
|-------|-------------|-----------|
| Немає API для upload фото | Висока | MVP: URL у comment + Telegram; Phase E |
| v2/v3 розділення endpoints | Середня | Окремий base URL у client; тести |
| Слоти змінюються між повідомленнями | Висока | Повторний `slots/get` перед `book_appointment`; graceful «слот зайнятий» |
| Різні ціни по філіях | Середня | Завжди передавати `salon_id`; показувати ціну з `prices[]` |
| CleverBOX rate limits невідомі | Середня | Cache + backoff; не викликати slots на кожне повідомлення |
| Плутанина KeyCRM/CleverBOX у промпті | Середня | Чіткі tool descriptions + routing validation на бекенді |

---

## 9. Тест-план (регресія)

### Unit
- Mapping `ServiceItem` → `CrmServiceItem`
- `resolveCrmProvider` для всіх mode + invalid provider rejection
- Date format DD.MM.YYYY / HH:MM

### Integration (mock HTTP)
- Повний flow: search → slots → book
- Idempotent mirror (другий виклик не дублює запис)

### Manual E2E (пілотний салон)
1. Запит послуги «манікюр» → ціна з CRM
2. Вибір майстра → слоти фільтруються
3. Підтвердження → запис у CleverBOX UI
4. Фото → comment + Telegram
5. Status Blessed: замовлення футболки → лише KeyCRM

---

## 10. Оцінка трудомісткості

| Phase | Оцінка | Залежності |
|-------|--------|------------|
| 0 Discovery | 1–3 дні | Доступ до CleverBOX |
| A Adapter | 3–5 днів | Phase 0 |
| B Booking mode | 5–7 днів | A |
| C Sync + routing UI | 3–4 дні | A |
| D Hardening | 3–5 днів | B, C |
| E Photos | 2–5 днів | CleverBOX API clarity |

**Разом (до MVP booking):** ~2–3 тижні одного розробника після успішного Phase 0.

---

## 11. Порядок у загальному roadmap

Рекомендована послідовність відносно `FEATURE_AGENT_MODE_PLAN.md`:

1. ✅ Phase A/B agent modes (sales, leadgen) — зроблено
2. **Phase 0 CleverBOX discovery** — наступний крок
3. **Phase A–B CleverBOX** (цей документ)
4. Phase C production routing (manager pool) — паралельно або після пілоту салону

---

## 12. Відкриті питання (потрібна відповідь tenant / CleverBOX)

1. Чи є у пілотного салону **кілька філій** і чи треба вибір філії в діалозі?
2. Чи потрібна **онлайн-оплата** (invoice.link) в сценарії бота?
3. Чи продають салони **товари** (косметика) — потрібен гібрид KeyCRM + CleverBOX?
4. Чи є вимога **скасування/перенесення** з бота, чи лише через адміністратора?
5. CleverBOX: чи існує **недокументований** upload endpoint для client files?

---

*Документ створено: 2026-07-06. Автор: platform-ai-agent-direct engineering.*
