/**
 * Compact platform capability map for meta-agent (and docs sync).
 * Keep thin — modes, tools, CRM boundaries. No tenant-specific prices/policy.
 */

export function buildPlatformCapabilitiesBlock(): string {
  return `<platform_capabilities>
Платформа Instagram DM агента. Tenant обирає agent_mode і CRM routing в адмінці.

## Режими агента (agent_mode)

| Mode | Призначення | Фінальна дія |
|------|-------------|--------------|
| sales | E-commerce продаж | collect_order → локальне Замовлення (+ CRM якщо увімкнено); create_local_order при м'якій згоді |
| leadgen | Кваліфікація / бриф | submit_brief → локально + Telegram (+ KeyCRM lead якщо write увімкнено); create_local_order при згоді |
| booking | Запис у салон | book_appointment → CRM запису; create_local_order якщо погодили послугу/дзвінок без слоту |
| general | Усі сценарії (default) | Union tools sales+leadgen+booking (без окремого списку — додаєш tool у спеціалізований режим → general підхоплює) |

## Tools за режимом (бекенд виконує; у промпті інструкції КОЛИ їх викликати)

Lookup (search_catalog, search_services, get_available_slots, get_delivery_cost, get_client_crm_history) — native in-process MCP (ті самі handlers, що conversation.ts). Default CLAUDE_RUNTIME=sdk. Terminal (book/cancel/reschedule/collect/handoff) — теж native MCP + canUseTool; виконує conversation.ts (другий book на іншу дату ≠ move — для перенесення reschedule_appointment). BeautyPro booking — force=true за замовчуванням. CLAUDE_RUNTIME=cli — hotfix, текстовий <tool_call>. get_client_crm_history лише коли є booking-tools (booking/general) + привʼязаний CRM-клієнт.

Порожній search_services — не вигадувати ціну. BeautyPro UUID клієнту не світити.

Спільні: update_client_info, tag_client, request_handoff, create_local_order; set_conversation_branch (якщо є філії).

sales: search_catalog, get_delivery_cost, collect_order
leadgen: classify_intent, submit_brief
booking: classify_intent, search_services, get_available_slots, get_client_crm_history, attach_reference_photo, book_appointment, cancel_appointment, remove_appointment_service, reschedule_appointment
general: усі з sales + leadgen + booking (dedupe). Новий tool у будь-якому спеціалізованому режимі → автоматично в general.
Refund / скасування оплати → request_handoff. Скасувати візит → cancel_appointment; одну послугу → remove_appointment_service; перенести → reschedule_appointment (не другий book_appointment).

Telegram-сповіщення менеджерам — НЕ окремий tool (йдуть з collect_order / create_local_order / brief / booking / handoff).

## Замовлення (sales / collect_order / create_local_order) — джерело правди

1. create_local_order — коли клієнт погодився на товар/послугу/дзвінок («оформляйте»). Завжди локальна БД + Telegram; CRM sync = skipped.
2. collect_order — повне e-com (товар + ПІБ + телефон + місто/НП + оплата). ЗАВЖДИ локальна БД; + CRM mirror якщо write і KeyCRM createOrder.
3. Не пиши в промпті «створи замовлення в KeyCRM» — пиши «викликай create_local_order при згоді» / «collect_order коли підтвердив усі дані доставки».

## CRM (через CrmAdapter + crm_routing, не хардкод у промпті)

| Provider | Що вміє |
|----------|---------|
| keycrm | catalog, orders, leads, client upsert |
| cleverbox | services, branches, booking |
| beautypro | services, branches, booking, client upsert, visit history |

Гібрид: by_action (напр. catalog/order→keycrm, services/booking→beautypro|cleverbox).
Client.crmBuyerId — привʼязка IG-клієнта до CRM (телефон / адмінка / після запису).
Історія візитів (фактична тривалість + professionalId / master_id) — get_client_crm_history + runtime-блок. Платформа підставляє персональну duration у free_time / book.

## Booking master preference (booking / general)

- Повторний клієнт: історія з [master_id=…] → запропонуй цього майстра ЛИШЕ для схожої послуги → get_available_slots з master_id → book з тим id.
- Інша категорія (напр. тонування після манікюру в історії) — НЕ reuse улюбленого master_id; слоти без нього або з майстром зі слотів саме для нової послуги.
- Два майстри з однаковим імʼям — у слотах підпис з positions / [#uuid]; у tools завжди UUID з останнього get_available_slots, не імʼя.
- Платформа відхиляє book_appointment з MASTER_SERVICE_MISMATCH, якщо грейд майстра не має ціни на послугу (типовий кейс «не та Анастасія»).
- Перед записом платформа звіряє GET /employees/free_time: MASTER_DAY_CLOSED (день не відкритий у графіку майстра) або SLOT_NOT_AVAILABLE (час не в free_time). force=true більше не дозволяє пропихнути запис у закритий день з агентного шляху.
- Новий клієнт: get_available_slots без master_id → підтвердження → book; master_id лише якщо клієнт обрав майстра зі слотів.
- Паралельно (манікюр + брови в один час): різні майстри → services[].master_id на кожному рядку get_available_slots і book_appointment. Один майстер на всі послуги — top-level master_id (послуги йдуть підряд у часі).
- Різні години старту (стрижка 10:30, манікюр 11:00): services[].start_time на кожному рядку book_appointment; без цього CRM стартує всі з одного time.
- Один візит = один book_appointment з усіма services[] (одне локальне замовлення). Повтор на той самий date+time у тій самій розмові змерджиться в один Appointment/Order; BeautyPro CRM — PUT action=insert для нових рядків.
- Дві+ окремі послуги: спочатку пошукай комплекс/пакет у search_services; якщо є вигідніший SKU — запропонуй.
- Після успішного book платформа сама шле клієнту підтвердження з датою/часом/послугами — не обіцяй «зараз надішлю підтвердження» без деталей.
- Swap майстрів між послугами або +третя послуга на той самий час → новий get_available_slots, потім book. Не стверджуй «усі вільні» без tool.
- TIME_CONFLICT від CRM → альтернативні слоти з tool result; клієнту не казати «записали».
- Клієнту показуй лише імена майстрів; ids — тільки в tool args.
- Не вигадуй окремі tools на кшталт get_master_availability — лише get_available_slots.master_id / services[].master_id.
- Заборонено filler «зараз пошукаю/перевірю» без search_services / get_available_slots у тій самій відповіді. Платформа один раз форсить recovery, якщо агент пообіцяв пошук без tool_call.
- Після search_services платформа виконує follow-up get_available_slots з наступного ходу Claude (ланцюг search → slots), щоб клієнт не лишався на «зараз перевірю вікна».

## Booking prices by master grade (BeautyPro positions)

- Live ціни — з tool results / services-live (після sync), не хардкод у промпті tenant.
- search_services: діапазон + розбивка грейдів (назви з CRM positions). Без майстра — цитуй range / «від».
- get_available_slots + master_id: блок «Ціни для обраного майстра» = точна цитата; «недоступно» = цей рівень не робить послугу → інший майстер.
- book_appointment: можна передати services[].price з цитати слотів; CRM BeautyPro рахує ціну сам — поле для локального запису/клієнта.
- Не хардкодь UUID позицій і не вигадуй назви грейдів поза tool/catalog.

Smart-trigger / ремаркетинг (Агент і SLA): якщо бот написав і клієнт мовчить N годин (default 18 / max 24) — платформа ставить FollowUpJob у чергу і в runAt один раз викликає агента (контекстний soft-nudge, не шаблон). Воркер бере лише due-джоби. Для Instagram — лише в межах ~24h messaging window Meta.
Затримка відповіді (responseDelayMin/MaxSeconds у agent_config): пауза 0–60 с перед генерацією відповіді (typing вже увімкнений); 0 = одразу.
Часовий пояс tenant (agent_config.timezone, default Europe/Kyiv): «зараз», робочі години і межі цивільного дня для CRM-слотів (BeautyPro free_time from/to). Сервер може бути в DE — календар салону не бере системний TZ.

## Instagram inbound nuances (webhook → Claude)

- Відповідь на Stories (reply_to.story) — агент отримує маркер + кадр Stories у vision (якщо CDN ще живий).
- Story mention — маркер без довготривалого кешу медіа (Meta policy).
- Реакції (message_reactions) — синтетичний inbound + короткий теплий ack; unreact ігнорується.
- Shared post (пересланий пост) — окремий шлях з catalog search (як і раніше).

## Knowledge / prompts (tenant)

- **Business facts** (brand, contacts, delivery, FAQ, rules) → active system prompt in DB (Admin → Prompts).
- **Live catalog** → knowledge/catalog.txt, services-live.txt, masters-live.txt (CRM sync) + tools search_catalog / search_services.
- Seed files: prompts/{sales|leadgen|booking|general}-agent.txt (first DB seed = **general**, matches default agent_config.mode).
- Legacy knowledge/{contacts,delivery,faq,...}.txt are **not** injected at runtime.

## Правила редагування промпту

- Не вигадуй tools, яких немає в таблиці вище.
- Не пиши «викликай CRM API» — лише назви tools (collect_order, create_local_order, book_appointment, …).
- Не хардкодь CleverBOX/BeautyPro/KeyCRM у промпті, якщо tenant може міняти routing — пиши «CRM запису» / «каталог» / «локальні замовлення».
- Зберігай безпеки: handoff, не змішувати клієнтів, не світити internal ids клієнту.
</platform_capabilities>`;
}
