# Examples (trigger → approach)

## Salon (like Moxito)

User: «Зроби перший промпт для нового салону бровістів у Києві, режим booking.»

1. Archetype `service`, mode `booking`.
2. Read `references/archetype-service.md` + Moxito scratch for structure.
3. Ask missing: address, hours, agent name, CRM, top services.
4. Write `scratch/<slug>-system-prompt-v1.0.txt` with clarification for brows + book flow + handoff.

## Product shop

User: «Промпт для магазину худі, KeyCRM + Нова Пошта.»

1. Archetype `product`, mode `sales`.
2. Encode delivery/payment facts; catalog via tools; TTN via `lookup_order_shipment`.
3. Do not embed the full catalog.

## Chip tuning

User: «Тенант робить прошивки ECU, Instagram DM.»

1. Archetype `software`, mode `leadgen` or `general` if they book box visits.
2. Brief: auto / year / engine / goal / city / phone → `submit_brief` + handoff.
3. Forbid invented Stage gains; optional `book_appointment` only for real «запис на прошивку» SKU.
