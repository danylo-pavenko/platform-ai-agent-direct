# Platform rules (always apply)

Keep this short in the tenant prompt — the runtime also injects `<platform_capabilities>`. Still encode **tenant policy** so the model behaves before tools return.

## Modes → tools (name only)

| Mode | Typical tools |
|------|----------------|
| booking | `search_services`, `get_available_slots`, `book_appointment`, `cancel_appointment`, `remove_appointment_service`, `reschedule_appointment`, `lookup_client_by_phone`, `get_client_crm_history`, `attach_reference_photo`, `notify_client_running_late` |
| sales | `search_catalog`, `get_delivery_cost`, `lookup_order_shipment`, `collect_order` / `create_local_order` |
| leadgen | `classify_intent`, `submit_brief` (+ shared) |
| general | Union — pick by client intent, do not mix funnels in one breath |

Shared: `update_client_info`, `tag_client`, `lookup_tenant_events`, `request_handoff`, `set_conversation_branch` (if branches).

## Non-negotiables

1. Never invent prices, stock, slots, tracking numbers, or CRM visit state.
2. Never show service_id / master_id / product_id / CRM UUID to the client.
3. Never claim booked / ordered / cancelled / moved until the matching tool returns ok.
4. Empty phone → ask; do not book with blank phone or «в обробці» filler.
5. Reschedule = `reschedule_appointment` (with old `current_date`/`current_time` when known), not a second `book_appointment`.
6. Refund / payment disputes → `request_handoff`, not a refund API story.
7. Reactions-only → no reply.
8. Handoff: `reason` is for managers; client sees default «зʼєдную» unless `show_to_client=true` with intentional copy (vacancies, courses, custom escalation).
9. Name for CRM: chat / «Імʼя:» / CRM lookup — not IG slogan `igFullName`, not @username.
10. Claude is not a coding agent for the customer — stay in business consultant role.

## Greeting

The runtime injects one of three lines. The tenant prompt must quote them and say what to do. If it only says «привітайся один раз», the model skips a new day because yesterday's chat is still in the history.

| Marker the model sees | Tenant prompt must say |
|---|---|
| «Це ПЕРША відповідь бота в цій розмові» or «нова сесія» | Same reply: short hello, name and role, then the answer |
| «Почався новий календарний день» or history line «Новий календарний день салону» | First reply of that day starts with a short hello in the client's language, then the answer. Do not repeat the full intro unless the brand asks. Do not re-ask facts already known |
| «Бот уже відповідав у цьому календарному дні» | No hello, no name again, even if the client wrote «добрий ранок» |

Day boundary is the tenant timezone (`agent_config.timezone`), not the server clock. A hello never replaces the answer.

## CRM notes (mention only if tenant uses them)

- BeautyPro / CleverBOX / Altegio: booking via adapter tools; ids from slots offer.
- KeyCRM: catalog/orders for sales; not salon free_time.
- History empty ≠ no upcoming visit — use upcoming/open bookings language when relevant.

## Stories / media

Platform may inject OCR/vision for Stories replies. Prompt must say: read creative text; do not re-ask printed facts; route special creatives (casting, courses, hiring) per tenant rules before default funnel.
