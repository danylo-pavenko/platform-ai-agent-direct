# Multi-CRM Integration Guide

Інструкція для розробників і AI-агентів: як додавати нові CRM до платформи так, щоб **кожен тенант** міг мати **кілька CRM одночасно** (гібрид e-commerce + салон, або інша комбінація).

**Версія:** 2026-07-18  
**Cursor rule:** `.cursor/rules/beautypro-crm.mdc` (always-on hint for agents)

**Референс-реалізації:** KeyCRM (каталог, замовлення, ліди) + CleverBOX / BeautyPro (послуги, філії, запис)

---

## 1. Результати валідації поточної реалізації

### ✅ Що працює коректно

| Компонент | Статус | Деталі |
|-----------|--------|--------|
| **Adapter pattern** | OK | `CrmAdapter` в `apps/backend/src/services/crm/types.ts` — єдиний контракт для всіх CRM |
| **Registry** | OK | `getCrmAdapter(provider)` — кешований інстанс на провайдера |
| **Per-tenant routing** | OK | `settings.crm_routing` → `resolveCrmProvider(action)` |
| **Routing modes** | OK | `single` / `by_action` / `prompt` |
| **Capabilities** | OK | Кожен adapter оголошує `capabilities` — caller перевіряє перед write/booking |
| **Філії** | OK | Таблиця `branches` — runtime не залежить від CRM; CRM лише джерело імпорту |
| **Sync metadata** | OK | `crm_sync_runs` з `provider`, `syncType`, `artifacts.sources` |
| **Admin UI** | OK | `CrmRoutingCard`, `CleverboxCard`, `BranchesCard`, `SyncView` |
| **Agent modes** | OK | `sales` / `leadgen` / `booking` — tools через `buildAgentTools(mode)` |

### ✅ Call sites, що вже використовують routing

```
resolveCrmProvider('catalog')       → product-search, sync-worker (товари)
resolveCrmProvider('services')      → service-search, sync-worker (послуги)
resolveCrmProvider('booking')       → appointment, service-search (слоти)
resolveCrmProvider('branches')      → branches import
resolveCrmProvider('order')         → crm-sync mirrorOrderToCrm
resolveCrmProvider('lead')          → crm-sync mirrorBriefToCrm
resolveCrmProvider('client_upsert')   → crm-sync mirrorClientToCrm
```

### ⚠️ Відомі обмеження (не блокують, але враховувати при новій CRM)

| Місце | Проблема | Рекомендація при новій CRM |
|-------|----------|---------------------------|
| `routes/crm-fields.ts` | `getCrmAdapter()` без routing | Мапити `scope` → action (`buyer`→`client_upsert`, `order`→`order`, `lead`→`lead`) |
| `sync-worker.ts` | Перевірка credentials тільки для CleverBOX | Додати `isProviderConfigured(name)` у registry або integration-config |
| `IntegrationConfig` | Жорстко типізований під keycrm/cleverbox | Розширити інтерфейс або generic `Record<CrmProviderName, unknown>` |
| `CrmRoutingCard.vue` | Список провайдерів захардкоджений | Додати новий провайдер у UI при реєстрації |
| Health check | Окремі функції per-provider | Додати `checkCrmProvider(name)` за шаблоном CleverBOX |

---

## 2. Архітектура (mental model)

```
┌─────────────────────────────────────────────────────────────┐
│  Tenant settings (PostgreSQL `settings`)                    │
│  • crm_routing { mode, default, enabled_providers, routes } │
│  • integration_keycrm, integration_cleverbox, integration_* │
└──────────────────────────┬──────────────────────────────────┘
                           │
              resolveCrmProvider(action, { toolProvider? })
                           │
         ┌─────────────────┼─────────────────┐
         ▼                 ▼                 ▼
   keycrmAdapter    cleverboxAdapter    [newCrmAdapter]
   capabilities     capabilities        capabilities
         │                 │                 │
         └─────────────────┴─────────────────┘
                           │
     Consumers: sync-worker, product-search, service-search,
                crm-sync, appointment, branches, health-check,
                conversation (tools → services)
```

**Ключовий принцип:** жоден consumer не імпортує HTTP-клієнт CRM напряму. Тільки `getCrmAdapter(name)` + перевірка `capabilities`.

**Філії — окремо від CRM routing:**

- Runtime: `Conversation.branchId` → `branches` table (slug, displayName, keywords).
- CRM: `branches.crmProvider` + `branches.crmExternalId` для sync/mirror.
- Імпорт: `POST /branches/import-from-crm` через `resolveCrmProvider('branches')`.

---

## 3. Основні поняття

### 3.1 `CrmAction` — що саме робить система

Файл: `apps/backend/src/lib/crm-providers.ts`

| Action | Призначення | Типовий tool / flow |
|--------|-------------|---------------------|
| `catalog` | Товари, оффери, категорії | `search_products`, sync → `catalog.txt` |
| `services` | Каталог послуг | `search_services`, sync → `services-live.txt` |
| `branches` | Локації / філії | імпорт у `branches`, `set_conversation_branch` |
| `booking` | Запис на прийом | `get_available_slots`, `book_appointment` |
| `order` | E-commerce замовлення | `collect_order` → `mirrorOrderToCrm` |
| `lead` | Presale brief / лід | leadgen → `mirrorBriefToCrm` |
| `client_upsert` | Профіль клієнта в CRM | `update_client_info` mirror |

### 3.2 `CrmCapabilities` — що вміє провайдер

```typescript
interface CrmCapabilities {
  catalog: boolean;
  services: boolean;
  branches: boolean;
  orders: boolean;
  leads: boolean;
  booking: boolean;
}
```

Якщо `capabilities.booking === false` — **не реалізуй** `createBooking` і не маршрутизуй `booking` на цей провайдер.

### 3.3 `CrmRoutingMode`

| Mode | Поведінка |
|------|-----------|
| `single` | Усі actions → `default` provider |
| `by_action` | Кожен action → свій provider з `routes` |
| `prompt` | Agent може передати `crm_provider` у tool args; fallback → `routes[action]` |

### 3.4 Дефолтні маршрути (якщо tenant не налаштував)

```typescript
catalog: 'keycrm'
services: 'cleverbox'
branches: 'cleverbox'
order: 'keycrm'
lead: 'keycrm'
booking: 'cleverbox'
client_upsert: 'keycrm'
```

---

## 4. Матриця: функції × провайдери (поточний стан)

| Функція | KeyCRM | CleverBOX | BeautyPro | Де в коді |
|---------|--------|-----------|-----------|-----------|
| Каталог товарів | ✅ | ❌ (empty stubs) | ❌ | `keycrm.ts`, sync-worker |
| Пошук товарів | ✅ | ❌ | ❌ | `product-search.ts` |
| Послуги | ❌ | ✅ | ✅ | `cleverbox.ts`, `beautypro.ts`, `service-search.ts` |
| Філії | ❌ | ✅ | ✅ | `branches.ts`, `fetchBranches` |
| Слоти / запис | ❌ | ✅ | ✅ | `appointment.ts`, adapters |
| Замовлення | ✅ | ❌ | ❌ | `crm-sync.ts` |
| Ліди | ✅ | ❌ | ❌ | `crm-sync.ts` |
| Клієнт upsert | ✅ | ❌ | ✅ | `crm-sync.ts`, `beautypro.ts` |
| Custom fields | ✅ | ❌ | ❌ | `crm-fields.ts`, `listCustomFields` |

**Гібридний tenant (салон + магазин):** `crm_routing.mode = by_action`, KeyCRM для catalog/order, CleverBOX для services/booking/branches.

---

## 5. Checklist: додати нову CRM `{name}`

Скопіюй цей checklist у задачу / PR description.

### Фаза A — Backend core

- [ ] **A.1** `lib/crm-providers.ts` — додати `'{name}'` у `CRM_PROVIDER_NAMES`, `providerDisplayName()`
- [ ] **A.2** `services/crm/{name}.ts` — реалізувати `CrmAdapter`:
  - [ ] `name`, `capabilities` (чесно — тільки те, що підтримує API)
  - [ ] Обов'язкові read: `fetchCategories/Products/Offers`, `searchProducts/Offers` (можуть повертати `[]` якщо N/A)
  - [ ] Optional writes: лише ті, де `capabilities.* === true`
  - [ ] Salon optional: `fetchBranches`, `fetchServices`, `searchServices`, `getAvailableSlots`, `createBooking`
- [ ] **A.3** `services/crm/registry.ts` — `case '{name}': return {name}Adapter` + `listRegisteredCrmProviders()`
- [ ] **A.4** `services/crm/index.ts` — re-export якщо потрібно

### Фаза B — Конфігурація tenant

- [ ] **B.1** `lib/integration-config.ts`:
  - [ ] `Integration{Name}` interface
  - [ ] Додати в `IntegrationConfig`
  - [ ] Читання з `integration_{name}` setting + `.env` fallback
  - [ ] `SENSITIVE_FIELDS` для секретів
- [ ] **B.2** `config.ts` — Zod env vars (`{NAME}_API_KEY`, тощо)
- [ ] **B.3** `.env.example` — документувати змінні
- [ ] **B.4** `routes/settings.ts` — `INTEGRATION_KEYS` += `integration_{name}`

### Фаза C — Routing і consumers

- [ ] **C.1** Оновити `DEFAULT_ROUTES` у `crm-routing.ts` **лише якщо** нова CRM має стати default для якогось action
- [ ] **C.2** Перевірити всі `resolveCrmProvider` call sites — чи потрібна логіка credentials для нового провайдера
- [ ] **C.3** `sync-worker.ts` — якщо CRM дає catalog або services, додати перевірку `isConfigured` + sync artifact
- [ ] **C.4** `health-check.ts` — додати перевірку ping/read для нового провайдера
- [ ] **C.5** `crm-fields.ts` — якщо CRM має custom fields, використовувати routing замість `getCrmAdapter()`

### Фаза D — Admin UI

- [ ] **D.1** `components/settings/{Name}Card.vue` — поля інтеграції (секрети masked як `••••••`)
- [ ] **D.2** `SettingsView.vue`:
  - [ ] import card, `integrations.{name}` ref
  - [ ] `fetchIntegrations` / `saveIntegrations`
  - [ ] nav item `#settings-{name}`
- [ ] **D.3** `CrmRoutingCard.vue` — додати провайдер у `providerItems` і chip group
- [ ] **D.4** `SyncView.vue` — якщо sync пише новий artifact, переконатись що колонки показують provider

### Фаза E — Agent (якщо CRM впливає на tools)

- [ ] **E.1** `tool-definitions.ts` — оновити enum `crm_provider` у booking tools (якщо `mode=prompt`)
- [ ] **E.2** Seed prompt / knowledge — бізнес-правила tenant, не hardcode в коді
- [ ] **E.3** `agent_mode` — новий mode лише якщо принципово інший набір tools

### Фаза F — Тести і документація

- [ ] **F.1** Unit test adapter mapping (mock HTTP)
- [ ] **F.2** Unit test `resolveCrmProvider` з різними `crm_routing` configs
- [ ] **F.3** Оновити цей документ — рядок у матрицю §4
- [ ] **F.4** Smoke на staging: Health Check → Sync → tool flow

---

## 6. Шаблон adapter (мінімальний)

```typescript
// apps/backend/src/services/crm/acme.ts
import type { CrmAdapter, CrmProduct } from './types.js';
import { getIntegrationConfig } from '../../lib/integration-config.js';

export const acmeAdapter: CrmAdapter = {
  name: 'acme',
  capabilities: {
    catalog: true,
    services: false,
    branches: false,
    orders: true,
    leads: false,
    booking: false,
  },

  async fetchCategories() { /* ... */ return []; },
  async fetchProducts() { /* paginate API */ return []; },
  async fetchOffers() { return []; },
  async searchProducts(params) { /* ... */ return []; },
  async searchOffers(params) { return []; },

  async findClient(match) { /* optional */ return null; },
  async upsertClient(id, input) { /* ... */ return { crmBuyerId: '...' }; },
  async createOrder(input) { /* ... */ return { crmOrderId: '...' }; },
};
```

**Правила:**

1. Не кидати exception на unsupported action — повертати `[]` або пропускати method.
2. Секрети тільки з `getIntegrationConfig()` / `config.ts`, ніколи з логів.
3. HTTP retries / timeout — як у `keycrm.ts` / `cleverbox.ts`.
4. ID mapping: CRM може використовувати number/string — нормалізуй у adapter, назовні — стабільний тип.

---

## 7. Шаблон integration config

```typescript
// integration-config.ts
export interface IntegrationAcme {
  apiKey: string;
  baseUrl: string;
  syncIntervalMin: number;
}

// У getIntegrationConfig():
acme: {
  apiKey: sanitizeIntegrationSecret(a.apiKey) || config.ACME_API_KEY,
  baseUrl: a.baseUrl || config.ACME_BASE_URL,
  syncIntervalMin: a.syncIntervalMin ?? config.ACME_SYNC_INTERVAL_MIN,
},

// SENSITIVE_FIELDS:
integration_acme: ['apiKey'],
```

```bash
# .env.example
ACME_API_KEY=
ACME_BASE_URL=https://api.acme.example
ACME_SYNC_INTERVAL_MIN=30
```

---

## 8. Налаштування тенанта (операційна інструкція)

### 8.1 Тільки e-commerce (KeyCRM)

```
crm_routing.mode = single
crm_routing.default = keycrm
enabled_providers = [keycrm]
agent_config.mode = sales
```

### 8.2 Тільки салон (CleverBOX)

```
crm_routing.mode = by_action
routes: catalog→keycrm (або не використовується), services/booking/branches→cleverbox
agent_config.mode = booking
Філії: імпорт з CRM або вручну
CleverBOX: apiToken + defaultBranchId
```

### 8.3 Гібрид (магазин + салон)

```
crm_routing.mode = by_action
routes:
  catalog, order, lead, client_upsert → keycrm
  services, booking, branches → cleverbox
enabled_providers = [keycrm, cleverbox]
```

Одна IG-сторінка, кілька філій салону — через `branches` + `set_conversation_branch` tool.

### 8.4 Після deploy

```bash
cd apps/backend
npx prisma migrate deploy
npx prisma generate
pm2 restart {INSTANCE}-api {INSTANCE}-sync
```

Admin → Settings → Health Check → Sync.

---

## 9. Що НЕ робити

| Anti-pattern | Чому |
|--------------|------|
| `import` HTTP клієнта CRM у `conversation.ts` | Порушує adapter boundary |
| Hardcode `getCrmAdapter('keycrm')` у новому коді | Використовуй `resolveCrmProvider(action)` |
| Зберігати філії тільки в CRM без `branches` table | Runtime prompt/tools потребують локальний slug |
| Додавати scope OAuth Meta для CRM | Meta scopes — окремо (див. `.cursor/rules/meta-oauth-scopes.mdc`) |
| Змішувати `Order` і `Appointment` | Різні домени, різні CRM actions |
| Реальні ціни в коді | Tenant system prompt + knowledge files |

---

## 10. PROMPT для AI-агента (copy-paste)

Використовуй цей блок як стартовий промпт при додаванні нової CRM:

---

```
Контекст: platform-ai-agent-direct — multi-tenant IG DM AI agent.

Задача: додати CRM провайдер `{PROVIDER_SLUG}` ({PROVIDER_DISPLAY_NAME}).

Обов'язково прочитай перед кодом:
- docs/MULTI_CRM_INTEGRATION_GUIDE.md (цей файл)
- apps/backend/src/services/crm/types.ts (контракт CrmAdapter)
- apps/backend/src/lib/crm-routing.ts (per-tenant routing)
- Референс: apps/backend/src/services/crm/keycrm.ts або cleverbox.ts

Capabilities нової CRM (заповни чесно):
- catalog: {true|false}
- services: {true|false}
- branches: {true|false}
- orders: {true|false}
- leads: {true|false}
- booking: {true|false}

API документація / endpoints:
{PASTE_API_NOTES}

Виконай checklist з §5 документа MULTI_CRM_INTEGRATION_GUIDE.md:
1. crm-providers.ts + adapter + registry
2. integration_{slug} в settings + config.ts + .env.example
3. resolveCrmProvider у всіх нових call sites (НЕ getCrmAdapter() без provider)
4. Admin card + CrmRoutingCard provider list
5. health-check + sync-worker artifacts якщо є catalog/services
6. Мінімальні unit tests

Обмеження:
- Не змінюй Meta OAuth scopes
- Філії завжди в таблиці branches (CRM = import source)
- Код англійською, UI/доки для розробника — українською
- Мінімальний diff, без over-engineering
- Не комітити .env / secrets

Після імплементації:
- Оновити матрицю в §4 MULTI_CRM_INTEGRATION_GUIDE.md
- Вказати приклад crm_routing JSON для tenant
```

---

## 11. Приклад `crm_routing` JSON (гібрид)

```json
{
  "mode": "by_action",
  "default": "keycrm",
  "enabled_providers": ["keycrm", "cleverbox"],
  "routes": {
    "catalog": "keycrm",
    "services": "cleverbox",
    "branches": "cleverbox",
    "booking": "cleverbox",
    "order": "keycrm",
    "lead": "keycrm",
    "client_upsert": "keycrm"
  }
}
```

Зберігається в `settings.key = 'crm_routing'`. Редагується в Admin → Settings → CRM routing.

---

## 12. Файли — швидкий індекс

| Файл | Роль |
|------|------|
| `lib/crm-providers.ts` | Імена провайдерів, CrmAction enum |
| `lib/crm-routing.ts` | getCrmRouting, resolveCrmProvider |
| `services/crm/types.ts` | CrmAdapter interface |
| `services/crm/registry.ts` | Factory + cache |
| `services/crm/keycrm.ts` | E-commerce reference |
| `services/crm/cleverbox.ts` | Salon/booking reference (CleverBOX) |
| `services/crm/beautypro.ts` | Salon/booking (BeautyPro / AI Helps) |
| `lib/integration-config.ts` | Per-tenant secrets (DB + env) |
| `sync-worker.ts` | Catalog + services sync |
| `services/crm-sync.ts` | Mirror client/order/lead |
| `services/appointment.ts` | Booking mirror |
| `services/branches.ts` | Multi-branch runtime |
| `admin/.../CrmRoutingCard.vue` | Routing UI |
| `prisma/schema.prisma` | Branch, Appointment, CrmSyncRun |

---

## 13. Наступні покращення платформи (не блокують нові CRM)

1. `isProviderConfigured(provider): Promise<boolean>` у registry
2. Generic integration config map замість жорсткого union type
3. `crm-fields` routing по scope
4. Admin: список провайдерів з API замість hardcode у Vue
5. Appointments list в admin UI

---

*Документ підтримується разом з кодом. При додаванні CRM — оновлюй §4 і §12.*
