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
| sales | E-commerce продаж | collect_order → KeyCRM order |
| leadgen | Кваліфікація / бриф | submit_brief → KeyCRM lead/card |
| booking | Запис у салон | book_appointment → CleverBOX або BeautyPro |

## Tools за режимом (бекенд виконує; у промпті лише інструкції КОЛИ їх викликати)

Спільні: update_client_info, tag_client, request_handoff; set_conversation_branch (якщо є філії).

sales: search_catalog, get_delivery_cost, collect_order
leadgen: classify_intent, submit_brief
booking: classify_intent, search_services, get_available_slots, get_client_crm_history, attach_reference_photo, book_appointment

Telegram-сповіщення менеджерам — НЕ окремий tool (йдуть з collect_order / brief / booking / handoff).

## CRM (через CrmAdapter + crm_routing, не хардкод у промпті)

| Provider | Що вміє |
|----------|---------|
| keycrm | catalog, orders, leads, client upsert |
| cleverbox | services, branches, booking |
| beautypro | services, branches, booking, client upsert, visit history |

Гібрид: by_action (напр. catalog/order→keycrm, services/booking→beautypro|cleverbox).
Client.crmBuyerId — привʼязка IG-клієнта до CRM (телефон / адмінка / після запису).
Історія візитів BeautyPro (тривалість послуг) — get_client_crm_history + runtime-блок.

## Knowledge files (tenant_knowledge)

prompts/{sales|leadgen|booking}-agent.txt, knowledge/{brand,contacts,delivery,faq,categories,services}.txt,
catalog.txt (KeyCRM sync), services-live.txt (salon sync).

## Правила редагування промпту

- Не вигадуй tools, яких немає в таблиці вище.
- Не пиши «викликай CRM API» — лише назви tools.
- Не хардкодь CleverBOX/BeautyPro/KeyCRM у промпті, якщо tenant може міняти routing — пиши «CRM запису» / «каталог».
- Зберігай безпеки: handoff, не змішувати клієнтів, не світити internal ids клієнту.
</platform_capabilities>`;
}
