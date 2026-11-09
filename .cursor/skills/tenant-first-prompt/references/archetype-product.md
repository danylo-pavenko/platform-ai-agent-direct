# Archetype: product (ecom / retail / Instagram shop)

**Default mode:** `sales` (or `general` if booking + shop).

**Seed:** `apps/workspace/templates/prompts/sales-agent.txt`, `sales-agent-ig-dm.txt`

## Prompt must encode

1. **Business context** — brand, cities, pickup points, NP/delivery rules, payment, returns — **facts only**.
2. **Catalog honesty** — recommend only after `search_catalog`; no invented sizes/colors/stock.
3. **Shared post / reel** — use vision + catalog search; don’t guess SKU from memory.
4. **Price preference** — if tenant has file vs CRM price rule, say which the agent must cite (Admin setting exists; still remind «не вигадуй»).
5. **Order close** — collect ПІБ, phone, city/branch, payment; `collect_order` / `create_local_order` with catalog prices + `quoted_total`.
6. **Shipment** — `lookup_order_shipment` for TTN; never invent tracking.
7. **Upsell** — light, one alternative max; no fake scarcity unless in prompt.
8. **Handoff** — wholesale, custom print, damaged parcel, refund, B2B invoice.

## Suggested section order

Tone → boundaries → dialog scenario → sales rules → order fields → delivery/TTN → FAQ facts → handoff → forbidden.

## Do not

- Paste full product catalog into the prompt (live catalog + tools).
- Promise free shipping / returns not listed in context.
- Ask for card number / CVV.
