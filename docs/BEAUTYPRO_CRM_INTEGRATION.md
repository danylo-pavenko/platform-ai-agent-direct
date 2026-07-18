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
3. В Admin → Settings → BeautyPro зберегти credentials.
4. Власник бази: BeautyPro → Settings → Marketplace → **Grant access**.
5. Adapter викликає `GET /auth/database`, зберігає access/refresh tokens (TTL 24h), refresh через `/auth/refresh`.

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
| `createBooking` | `POST /clients` + `POST /appointments` (+ optional `pick_professional`) |
| `cancelBooking` | `PUT /appointments/{id}` → `state: cancelled` |
| `findClient` / `upsertClient` | `GET/POST/PUT /clients` |

## Client link + visit history

| Flow | Що робить |
|------|-----------|
| Авто (телефон) | `linkClientToCrm` після `update_client_info` / heuristic / admin save phone → `GET /clients?phone=` |
| Booking | `createBooking` повертає `crmBuyerId` → persist на `Client` |
| Адмінка | Conversation → профіль: «Знайти за телефоном», UUID вручну, історія візитів |
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
