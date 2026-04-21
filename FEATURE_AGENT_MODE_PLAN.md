# Agent Modes & Lead-Gen Support — Implementation Plan

**Контекст.** Платформа починалась як бот-продавець для одного e-commerce клієнта
(Status Blessed). Тепер заходять клієнти з іншим сценарієм: не продаж товару, а
**кваліфікація ліда** (пресейл-бриф у діджитал-агенції, запис на консультацію,
збір заявки на B2B-сервіс тощо). Бот має відписувати в Instagram Direct 24/7,
вести діалог за заданим сценарієм, заповнити структуровану заявку/бриф/замовлення
і передати все в CRM — для будь-якого з цих бізнесів.

Цей документ фіксує фазовий план, який робить платформу **мульти-режимною**:
один і той самий кор-рантайм, але tenant вибирає тип сценарію та конфігурацію
під свій бізнес.

---

## Мета

1. **Multi-mode runtime.** Один бекенд підтримує кілька «режимів агента»
   (`sales`, `leadgen`, потенційно далі — `booking`, `support`), кожен зі своїм
   seed-промптом, своїм набором tool-ів і своєю формою фінальної заявки.
2. **CRM-agnostic deal surface.** Бот створює в CRM або `order` (товари+адреса),
   або `lead/card` (бриф без товарів) — залежно від режиму. KeyCRM — перший
   адаптер; інтерфейс готовий до інших.
3. **Tenant-driven customization.** Tenant конфігурує режим, робочі години,
   SLA, кастомні поля CRM — з адмінки, без зміни коду платформи.
4. **Вимірюваний пілот.** Кожен новий tenant — це пілот. Платформа міряє
   швидкість, повноту даних, частоту ескалацій і якість фінальної заявки,
   щоб було що показати замовнику.

---

## Статус реалізації (станом на 2026-04-22)

**Phase A — mode foundation: ✅ DONE**
- A.1 Schema (PresaleBrief, intent, agent_mode/ooh/sla settings, lead scope)
- A.2 Seed content (leadgen-agent.txt, services.txt) — у `apps/workspace/templates/`
- A.3 Tool layer (`classify_intent`, `submit_brief`, `buildAgentTools(mode, …)`)
- A.4 Conversation handler (mode wiring, submit_brief/classify_intent handlers)
- A.5 Prompt builder (mode, `out_of_hours_strategy`, `manager_sla_hours_business`, placeholders)
- A.6 CRM layer (`createLead` у KeyCRM через pipelines/cards, `mirrorBriefToCrm`)
- A.7 Admin UI (Settings — agent mode/OOH/SLA/freshness; CrmFields — lead scope)

**Phase B — measurement & lifecycle: ✅ DONE**
- B.1 Brief completeness (`completenessPct` синхронно на submit) + confidence KPI
- B.2 Brief quality rating (1–5 зірок + note на Conversation) — UI у ConversationDetail, avg-quality KPI на дашборді
- B.3 Session freshness (закриття `bot`-розмов старших за `session_freshness_days`, recap попереднього брифу з R6-гейтом: `briefQuality ≥ 3` або completeness fallback)
- B.4 Time-to-first-response (`firstInboundAt` / `firstOutboundAt` + `/analytics/ttfr` з p50/p95)
- B.5 CRM fallback → Telegram alert зі snapshot-ом для ручного введення

**Phase C — production routing: 🕐 TODO** (manager pool, routing, intent-based analytics) — чекаємо результатів пілоту.

### Що потрібне перед продом leadgen-пілоту

1. Запустити міграції: `20260422000000_add_agent_modes_and_briefs`, `20260422130000_add_ttfr_fields`, `20260422150000_add_conversation_brief_quality`.
2. В адмінці tenant'а виставити `agent_mode=leadgen`, `out_of_hours_strategy=defer_to_end`, `session_freshness_days`, `manager_sla_hours_business`.
3. Заповнити `apps/workspace/templates/knowledge/services.txt` під клієнта.
4. Додати KeyCRM field mappings зі scope=lead для кастомних полів брифу.
5. Перевірити доступність `/pipelines/cards` на KeyCRM-акаунті (R1) — якщо недоступний, fallback через маркер-товар ще не реалізований, треба писати.

---

## Чому не «скопіювати код під кожного клієнта»

- Операційно не масштабується — кожен tenant отримує свій кодовий бранч →
  кожен deploy ризикує регресом у сусідів.
- Технічно ми вже маємо multi-tenant інфру: окремий PM2 префікс,
  окрема DB, окрема папка workspace, per-tenant `CrmFieldMapping`. Достатньо
  додати ще одну вісь варіативності — «режим агента».
- Бізнесово: заміна 1-2 seed-файлів + flag у settings — це годинна робота на
  новий tenant замість тижневої.

---

## Архітектурні рішення

### A1. Agent mode як setting

Додається ключ `agent_mode` у `settings` таблицю: `sales` | `leadgen`. Читається
в `conversation.ts` на кожен turn; гілкує вибір системного промпту, набору
tool-ів і цільової CRM-операції (order vs. lead).

### A2. Seed-промпти в workspace templates

`apps/workspace/templates/prompts/` отримує другий файл —
`leadgen-agent.txt`. `deploy-client.sh` копіює в tenant workspace лише той
промпт, що відповідає режиму; існуючі файли ніколи не перезаписує.

### A3. Tool set залежить від режиму

| Tool | sales | leadgen |
|---|---|---|
| `update_client_info` | ✓ | ✓ |
| `tag_client` | ✓ | ✓ |
| `request_handoff` | ✓ | ✓ |
| `classify_intent` (новий) | ✓ | ✓ |
| `collect_order` | ✓ | — |
| `get_delivery_cost` | ✓ | — |
| `submit_brief` (новий) | — | ✓ |

Tool-builder приймає mode і повертає правильний набір. Це єдина точка, де
tool set розгалужується.

### A4. Deal surface — `Order` vs. `PresaleBrief`

Після довгої перевірки рішення — **окрема модель `PresaleBrief`**, а не
generic «Deal з типом». Причини:
- `Order` має жорстку форму (items, npBranch, paymentMethod) — не
  абстрагується без псевдо-полів.
- Admin UI під ордери вже написаний і злітає з брифами формою (у брифу нема
  total, payment method тощо).
- Зрозуміліше для нових розробників і нових tenant'ів.

### A5. CRM-агностичний write path

`CrmAdapter` отримує новий опціональний метод `createLead(input: CrmLeadInput)`.
KeyCRM адаптер реалізує його через `/pipelines/cards` (якщо доступний у їхньому
API) або через fallback `/order` з одним `price=0` товаром-маркером + полями в
custom_fields. Реальну реалізацію визначаємо перед Phase A.4, коли перевіримо
доступність API на акаунті клієнта.

### A6. Розширений `CrmFieldScope`

Зараз scope ∈ {`buyer`, `order`}. Додаємо `lead` — щоб tenant міг мапити поля
брифу на custom fields pipeline-картки в KeyCRM, так само, як робить для
buyer.

### A7. Out-of-hours strategy

Зараз агент **у першому ж повідомленні** попереджає про неробочий час. Для
leadgen-сценарію це шкодить конверсії (ТЗ tkp: згадувати неробочий час лише
після зняття брифу, у фінальному повідомленні). Рішення — окремий setting
`out_of_hours_strategy` ∈ {`warn_early`, `defer_to_end`}. Sales-mode tenant
залишається на `warn_early`; leadgen-mode — `defer_to_end` за замовчуванням.

### A8. Manager SLA string

Setting `manager_sla_hours_business` (int, default 2). У leadgen-промпт
інʼєктиться рядок на кшталт «менеджер звʼяжеться протягом **2 годин** у
робочий час» — tenant міняє число з адмінки, без правок промпта.

---

## Phase A — mode foundation

Мінімум, щоб бот у leadgen-режимі міг вести розмову по сценарію, скласти
бриф і покласти його в CRM. Без вимірювань поки.

### A.1 Schema changes
- `SystemSetting` keys: `agent_mode`, `out_of_hours_strategy`, `manager_sla_hours_business`
- New model `PresaleBrief` (fields: businessName, niche, services[], budgetRange, budgetPeriod, desiredStart, deadline, geo, currentActivity, painPoints, contactChannel, contactTime, source, segment, priority, raw JSON payload, createdAt, conversationId, clientId, keycrmLeadId, status)
- `CrmFieldScope` enum: add `lead`
- `Conversation.intent String?` (nullable; filled by `classify_intent` tool)

### A.2 Seed content
- New `apps/workspace/templates/prompts/leadgen-agent.txt` — універсальний
  leadgen-промпт (з плейсхолдерами для назви агенції, послуг, SLA).
- New `apps/workspace/templates/knowledge/services.txt` — плейсхолдер-список
  послуг, які tenant заповнює під себе.
- `deploy-client.sh` копіює той промпт, що відповідає `AGENT_MODE` у `.env`;
  існуючі файли не перезаписує.

### A.3 Tool layer
- New tools:
  - `classify_intent(intent: enum)` — пишеться в `Conversation.intent`.
  - `submit_brief({...brief fields, custom_fields})` — створює `PresaleBrief`,
    дзеркалить у CRM.
- `buildAgentTools(mode, mappings)` замість `buildSalesAgentTools` — гілкує
  набір за mode.
- `update_client_info.custom_fields` залишається робочим для обох режимів
  (це реюз вже існуючого механізму).

### A.4 Conversation handler
- `handleIncomingMessage` читає `agent_mode` і передає в prompt-builder і
  tool-builder.
- Обробник `submit_brief` (новий): створює `PresaleBrief`, викликає
  `mirrorBriefToCrm` (fire-and-forget), повертає клієнту фінальну фразу.
- Обробник `classify_intent` (новий): оновлює `Conversation.intent`.
- `collect_order` / `get_delivery_cost` маршрути ігноруються в leadgen-режимі
  (там цих tool-ів і не буде в schema, тож це лише захист від edge-case).

### A.5 Prompt builder
- Приймає `agentMode`, `outOfHoursStrategy`, `managerSlaHours`.
- Якщо `defer_to_end` — не додає out-of-hours preamble; додає інструкцію
  «згадувати неробочий час лише у фінальному повідомленні після `submit_brief`».
- Інʼєктить SLA-рядок у leadgen-промпт.

### A.6 CRM layer
- `CrmAdapter.createLead?(input)` — optional method.
- KeyCRM implementation: PoC через pipeline cards; fallback через
  `/order` з маркер-товаром, якщо pipeline cards недоступні на акаунті.
- `CrmLeadInput` type: buyer snapshot + brief fields + custom fields.
- `mirrorBriefToCrm(briefId)` у `services/crm-sync.ts` — аналог
  `mirrorOrderToCrm`, з тим же трактуванням `CRM_WRITE_ENABLED` та
  idempotency через `keycrmLeadId`.

### A.7 Admin UI minimum
- В `SettingsView` додається секція «Режим агента»: dropdown для
  `agent_mode`, toggle/dropdown для `out_of_hours_strategy`, input для
  `manager_sla_hours_business`.
- `CrmFieldsView` отримує ще одне значення в dropdown scope: `lead`.

**Вихід Phase A:** tenant у leadgen-режимі веде повноцінний діалог за
сценарієм, знімає бриф, бриф лягає в CRM. Метрики старі (без brief-specific
KPI) — ще тільки латентність/success-rate з попередньої фази.

---

## Phase B — measurement & lifecycle

Коли leadgen-пілот уже запущений, треба вміти оцінювати якість і
керувати життєвим циклом розмов.

### B.1 Brief completeness & confidence
- `PresaleBrief.completenessPct Int` — обчислюється бекендом після
  `submit_brief`. Визначається як частка заповнених **key fields**
  (`niche`, `services`, `budgetRange`, `contactChannel`, `desiredStart` —
  налаштовується per-mode у коді).
- `PresaleBrief.confidence Float?` — агент вказує у `submit_brief`
  значення 0..1 (наскільки впевнений у повноті/правильності брифу).
- Експозиція в admin: колонка в списку розмов, KPI на dashboard
  («% лідів з completeness ≥ 80%»).

### B.2 Brief quality rating (human-in-the-loop)
- `Conversation.briefQuality Int?` (1–5) + `briefQualityNote String?`.
- UI: у `ConversationDetail.vue` — компонент зірок (1–5) + комент, доступний
  менеджеру для закритих розмов.
- Dashboard: середня якість як KPI.

### B.3 Session freshness / return window
- При incoming webhook: якщо `Conversation.lastMessageAt < now - 14d` і
  `state != 'closed'`, закрити поточну розмову, створити нову.
- Ретеншн регулюється setting `session_freshness_days` (default 14).
- У prompt-builder injектиться `previousBriefSummary` — короткий (2-3 рядки)
  summary попередньої завершеної розмови, щоб агент не перепитував усе
  спочатку і впізнав повернення.

### B.4 Time-to-first-response
- `Conversation.firstInboundAt`, `firstOutboundAt` (DateTime, nullable).
- Заповнюються в `handleIncomingMessage` / на sendText-шляху при першому
  збігу.
- Dashboard-KPI: median TTFR по tenant.

### B.5 CRM fallback → Telegram
- У `mirrorBriefToCrm` / `mirrorOrderToCrm` / `mirrorClientToCrm` на catch
  гілці — виклик `notifyCrmFallback(snapshot)` з повним брифом у службовий
  Telegram-чат менеджерів.
- Сигнал у чаті: «⚠️ CRM недоступна — бриф не записано; переношу сюди
  повний снепшот для ручного введення».
- Використовує існуючий `services/telegram-notify.ts`.

**Вихід Phase B:** tenant бачить на дашборді повний набір KPI (латентність,
success rate, completeness, quality, TTFR), а менеджер не втрачає ліда
навіть при падінні CRM.

---

## Phase C — production routing

Робиться тільки коли пілот відчутно підтвердив потребу.

### C.1 Manager pool & routing
- Нова модель `ManagerAgent { id, tgUserId, displayName, niche?, geo?, active, createdAt }`.
- Setting `routing_strategy` ∈ {`round_robin`, `first_available`, `by_niche`}.
- При успішному `mirrorBriefToCrm` / `mirrorOrderToCrm` призначається
  менеджер за стратегією, проставляється відповідальний у CRM (поле
  KeyCRM `manager_id`) і в Telegram персонально йому.
- Admin UI: список менеджерів, toggles, ручний reassign розмови.

### C.2 Intent-based analytics
- Dashboard breakdown по `Conversation.intent`: скільки нових лідів,
  скільки скарг, скільки спаму, скільки партнерств.
- Фільтр у `ConversationsView` по intent.

### C.3 SLA-aware copy
- Якщо `manager_sla_hours_business` змінюється — агент одразу відображає
  це у фінальних повідомленнях (нічого не правимо в коді, лише в тексті
  промпта через плейсхолдер `{manager_sla_hours_business}`, який
  prompt-builder вже резолвить).

### C.4 Advanced analytics
- Per-channel TTFR, per-intent completeness, тижневі cohort-report
  (скільки лідів → брифів → угод за тижневими когортами).

**Вихід Phase C:** платформа готова вимкнути «ручне прикриття» — вона сама
розподіляє, дзвонить у потрібний чат, звітує.

---

## Ризики та відкриті питання

### R1. KeyCRM pipeline cards API
Треба перевірити на акаунті клієнта, чи доступні `/pipelines/cards` у
публічному API. Якщо ні — Phase A.6 збирає бриф у `/order` з маркер-товаром
«Presale: {service}» і заповнює всі поля як `custom_fields`. Це робочий
fallback, але менеджеру доведеться пояснити структуру.

### R2. CrmFieldMapping scope migration
Розширення enum `CrmFieldScope` — це Postgres ALTER TYPE ADD VALUE, з
версією 10+ все ок. Існуючі маппінги (buyer/order) залишаються.

### R3. Сумісність зі Status Blessed
SB-tenant отримує `agent_mode=sales` за замовчуванням — нічого не
ламається, бо новий код лише додає гілки. Всі регресійні тести sales-режиму
треба пройти після Phase A.

### R4. Back-pressure через пам'ять розмов
Поточний ліміт 30 останніх повідомлень підходить для sales. Для leadgen
діалог може бути довшим (15–20 обмінів). Треба перевірити, чи 30 вистачає;
якщо ні — додати per-mode ліміт або summary-компресію, але не в цьому скоупі.

### R5. Мова / локалізація фінальних повідомлень
Зараз фінальні рядки хендоффа/ООН зашиті в коді українською. Якщо tenant
хоче англомовний акаунт — треба або за-налаштувати через settings
(`final_messages_locale`), або винести в prompt. Поза скоупом цього плану,
фіксуємо як наступна ітерація.

### R6. Авторизація для агентства на боці лід-джерела
ТЗ tkp ще просить «повертати ліда через N днів із піднятим контекстом» —
Phase B.3 це робить. Але якщо повернення через рік — завершений бриф
піднімати не завжди доречно. У B.3 вводимо правило: піднімаємо контекст
лише якщо попередня розмова завершилась з `briefQuality ≥ 3` і не
старша за `session_freshness_days * 3` днів.

---

## Порядок робіт

**Phase A** (≈3-4 дні):
A.1 schema → A.2 seed → A.5 prompt-builder → A.3 tools → A.4 handler →
A.6 CRM write → A.7 admin UI.

**Phase B** (≈2-3 дні):
B.4 TTFR → B.1 completeness → B.5 fallback → B.3 session freshness →
B.2 quality rating.

**Phase C** — відкладено до результатів пілоту.

---

## Не робимо в цьому плані

- Голосові/сторіз-reply (поза скоупом MVP за ТЗ).
- Автогенерація скриптів відповідей з реальних лог-ів (це навчання моделі,
  окремий трек).
- Juri / compliance / GDPR policy-документ — підключаємо через профіль
  tenant, юридичний текст не генеруємо.
- ML-based intent classification — зараз цілком вистачає LLM-розмітки
  через `classify_intent` tool.
