# BeautyPro (AI Helps) — план і статус інтеграції

**API:** https://aihelpssoft.github.io/documentations/  
**Onboarding:** https://aihelps.zendesk.com/hc/uk/articles/35437317241617  
**Референс у коді:** `apps/backend/src/services/crm/beautypro.ts`

## Capabilities

| Capability | Статус |
|------------|--------|
| services | ✅ |
| branches (locations) | ✅ |
| booking (free_time + appointments) | ✅ |
| client_upsert | ✅ |
| catalog / orders / leads | ❌ (не цільовий домен) |

## Auth

1. Зареєструвати інтеграцію в AI Helps (тариф Ultimate).
2. Отримати `application_id`, `application_secret`, `database_code`.
3. В Admin → Settings → BeautyPro зберегти credentials → **Перевірити підключення**.
4. Власник бази: BeautyPro → Settings → Marketplace → **Grant access**.
5. Adapter викликає `GET /auth/database`, зберігає access/refresh tokens (TTL 24h), refresh через `/auth/refresh`.

**Тестова vs бойова база:** окремого sandbox API **немає**. Той самий host `https://api.aihelps.com/v1/` (auth завжди на server 1). Різниця лише в `database_code` і Grant access на потрібній базі. Після токена data-запити йдуть на `api` / `api4` залежно від поля `server` у відповіді auth.

Кнопка «Перевірити підключення» → `POST /settings/beautypro/test` (auth + `GET /locations`).
Кнопка **DEBUG** → той самий endpoint з `debug: true`: етапи (`resolve_credentials` → `auth_database` → `grant_access` / `locations`), HTTP status, duration, response body (tokens redacted) + «Копіювати для підтримки».
Кнопки **Послуги + ціни / Майстри / Усе** → `POST /settings/beautypro/probe` (`datasets: locations|services|employees`) після Grant — повні списки з UUID для перевірки API.

## Auto crm_routing

Після `PUT /settings/integrations`:
- рівно **1** підключений CRM (KeyCRM / CleverBOX / BeautyPro) → `mode: single`, усі routes на нього;
- **2+** → лише додає провайдерів у `enabled_providers`, маршрути гібриду — вручну в «Маршрутизація CRM».

Мета-агент (Teach) **не** викликає CRM API в чаті — лише редагує промпт. Live CRM у IG DM йде через tools + `resolveCrmProvider`. Таймаут мета-агента: `CLAUDE_TEACH_TIMEOUT_MS` (default 10 хв).

## Tenant routing (приклад)

```json
{
  "mode": "by_action",
  "default": "beautypro",
  "enabled_providers": ["beautypro"],
  "routes": {
    "services": "beautypro",
    "branches": "beautypro",
    "booking": "beautypro",
    "client_upsert": "beautypro"
  }
}
```

Гібрид з KeyCRM: catalog/order/lead → keycrm, services/branches/booking → beautypro.

## MVP endpoints

| Метод adapter | BeautyPro API |
|---------------|---------------|
| `fetchBranches` | `GET /locations` |
| `fetchServices` / `searchServices` | `GET /services` + `/services/categories` |
| `getAvailableSlots` | `GET /employees/free_time` (+ `GET /employees`) |
| `createBooking` | `POST /clients` + `POST /appointments` (`state: planned`). Не передавати `fields=id` на POST (ні appointments, ні clients) — API 400 `Unknown parameter 'id'`; дефолтна 201 вже `{ id }`. |
| `cancelBooking` | `PUT /appointments/{id}` → `state: cancelled`. **Агент цього не викликає** — немає tool. Скасування/перенесення/оплата → `request_handoff`. |
| `findClient` / `upsertClient` | `GET/POST/PUT /clients`. GET `fields` і body: `comment` (не `comments`). |

## Agent: cancel / move / pay

Агент у booking **не** вміє скасувати візит, перенести слот або повернути оплату.

| Клієнт просить | Що має статись | Чому не «просто book знову» |
|----------------|----------------|-----------------------------|
| Скасувати запис | `request_handoff` (менеджер у BeautyPro) | `cancelBooking` є в adapter, але не в tools |
| Перенести на інший день/час | `request_handoff` | BeautyPro **мержить** лише той самий `date + location + client`; інша дата = **другий** запис |
| Скасувати/повернути оплату | `request_handoff` | Prepayment / `POST /sales:refund` / `POST /sales:cancel` **не в MVP** |

## `fields` (живий API суворіший за docs)

Live 400 `Unknown parameter 'X'` якщо ім'я **немає** в списку `fields` цього методу — навіть коли старше docs його згадує, або коли хочеш лише `id`.

| Виклик | Правило |
|--------|---------|
| `POST /appointments`, `POST /clients` | **Не** слати `fields` (у т.ч. `fields=id`). 201 і так `{ id }`. У body appointments **не** слати `id` рядків послуг. |
| `GET /clients` | `name,firstname,lastname,phone,email,comment,archive` — **`comment`**, не `comments`. POST/PUT body теж `comment`. |
| `GET /services` | Не слати `no_professional_price` (docs має, live 400). Ціни з `location_prices`. |
| `GET /locations` | Лише `fields=name,city,street,phone,timezone,active`. Фільтр `active=true` є на `GET /locations/{id}`, не на списку — фільтруємо в коді. |
| `GET /clients/{id}/history` | Підмножина офіційного списку; `items(id,name,type,quantity,sum)` дозволено docs. |
| `PUT /appointments/{id}` (cancel) | Без `fields`; body `{ state: 'cancelled', cancelReason }`. |

Джерело списків: [AI Helps API docs](https://github.com/AIHelpsSoft/documentations/blob/master/API_DOCUMENTATION.md). Перед новим `fields=` — звірити **конкретний** метод, не копіювати GET-список на POST.

## Client link + visit history

| Flow | Що робить |
|------|-----------|
| Авто (телефон) | `linkClientToCrm` після `update_client_info` / heuristic / admin save phone → `GET /clients?phone=` |
| Booking | `createBooking` повертає `crmBuyerId` → persist на `Client` |
| Адмінка | Conversation → профіль: «Знайти за телефоном», UUID вручну, історія візитів. **Замовлення:** список overlays статус Appointment; `POST /orders/:id/sync-crm` повторно викликає `createBooking`, якщо ще немає `crmRecordId`. |
| Агент | Prompt inject історії якщо linked; tool `get_client_crm_history` у booking mode |

API: `GET /clients/{id}/history` → duration + services → планування наступного слота.

Поля `Client`: `crmBuyerId`, `crmProvider`, `crmLinkedAt`.

## Операційний checklist

- [ ] Заявка AI Helps + тестова база
- [ ] Credentials у tenant Settings
- [ ] Marketplace Grant access
- [ ] Health Check → BeautyPro ok
- [ ] Імпорт філій
- [ ] Sync послуг
- [ ] Test book_appointment з IG DM
