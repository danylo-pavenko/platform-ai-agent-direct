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
| sales | E-commerce продаж | collect_order → локальне Замовлення в адмінці (+ CRM якщо увімкнено) |
| leadgen | Кваліфікація / бриф | submit_brief → локально + Telegram (+ KeyCRM lead якщо write увімкнено) |
| booking | Запис у салон | book_appointment → CRM запису (CleverBOX/BeautyPro) за routing |

## Tools за режимом (бекенд виконує; у промпті лише інструкції КОЛИ їх викликати)

Спільні: update_client_info, tag_client, request_handoff; set_conversation_branch (якщо є філії).

sales: search_catalog, get_delivery_cost, collect_order
leadgen: classify_intent, submit_brief
booking: classify_intent, search_services, get_available_slots, get_client_crm_history, attach_reference_photo, book_appointment

Telegram-сповіщення менеджерам — НЕ окремий tool (йдуть з collect_order / brief / booking / handoff).

## Замовлення (sales / collect_order) — джерело правди

1. collect_order ЗАВЖДИ створює рядок у локальній БД (адмінка → Замовлення). Без цього замовлення «не існує» для платформи.
2. Паралельно (не блокує клієнта): картка в Telegram менеджерам.
3. Якщо CRM write увімкнено І provider для action=order вміє createOrder (типово KeyCRM) — async mirror у CRM; статус crmSyncStatus: pending|synced|failed|skipped.
4. Якщо CRM вимкнено / не KeyCRM для orders — замовлення лишається лише локально (skipped); адмінка все одно показує його.
5. Не пиши в промпті «створи замовлення в KeyCRM» — пиши «викликай collect_order коли клієнт підтвердив усі дані».

## CRM (через CrmAdapter + crm_routing, не хардкод у промпті)

| Provider | Що вміє |
|----------|---------|
| keycrm | catalog, orders, leads, client upsert |
| cleverbox | services, branches, booking |
| beautypro | services, branches, booking, client upsert, visit history |

Гібрид: by_action (напр. catalog/order→keycrm, services/booking→beautypro|cleverbox).
Client.crmBuyerId — привʼязка IG-клієнта до CRM (телефон / адмінка / після запису).
Історія візитів BeautyPro (тривалість послуг) — get_client_crm_history + runtime-блок.
Smart-trigger / ремаркетинг (Агент і SLA): якщо бот написав і клієнт мовчить N годин (default 72 / max 168) — платформа один раз викликає агента з історією діалогу і системним промптом, щоб він написав контекстний soft-nudge (не шаблон, не окремий tool).
Затримка відповіді (responseDelayMin/MaxSeconds у agent_config): пауза 0–60 с перед генерацією відповіді (typing вже увімкнений); 0 = одразу.

## Instagram inbound nuances (webhook → Claude)

- Відповідь на Stories (reply_to.story) — агент отримує маркер + кадр Stories у vision (якщо CDN ще живий).
- Story mention — маркер без довготривалого кешу медіа (Meta policy).
- Реакції (message_reactions) — синтетичний inbound + короткий теплий ack; unreact ігнорується.
- Shared post (пересланий пост) — окремий шлях з catalog search (як і раніше).

## Knowledge files (tenant_knowledge)

prompts/{sales|leadgen|booking}-agent.txt, knowledge/{brand,contacts,delivery,faq,categories,services}.txt,
catalog.txt (KeyCRM sync), services-live.txt (salon sync).

## Правила редагування промпту

- Не вигадуй tools, яких немає в таблиці вище.
- Не пиши «викликай CRM API» — лише назви tools (collect_order, book_appointment, …).
- Не хардкодь CleverBOX/BeautyPro/KeyCRM у промпті, якщо tenant може міняти routing — пиши «CRM запису» / «каталог» / «локальні замовлення».
- Зберігай безпеки: handoff, не змішувати клієнтів, не світити internal ids клієнту.
</platform_capabilities>`;
}
