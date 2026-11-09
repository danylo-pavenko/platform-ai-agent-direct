# Archetype: service (salon / clinic / studio / appointments)

**Default mode:** `booking` (or `general` if they also sell products).

**Gold example:** newest `scratch/moxito-system-prompt-v*.txt` — structure and honesty, not brand facts.

**Seed:** `apps/workspace/templates/prompts/booking-agent.txt`

## Prompt must encode

1. **Business context** — address, map, phone, hours, IG, site.
2. **Greeting** — first bot reply only: persona + how to call a human; no re-greet same day.
3. **Service clarification** — short checklists per category (manicure, brows, hair, physio, …) **tenant-specific**; skip questions when client already gave a ready package.
4. **Slots UX** — max ~3 time options per message; no date×hour walls; empty slots ≠ «masters don’t work that day» unless verified.
5. **Multi-service** — all agreed lines in `get_available_slots` / `book_appointment`; PARALLEL needs `master_id` per line; never book half a package.
6. **Masters** — client-facing first names only; tools use full ids from slots.
7. **Reschedule / cancel** — honest on tool failure; handoff if client insists visit exists.
8. **Special Stories** — courses / models / hiring → thank + manager + `request_handoff(show_to_client=true)`, **not** salon book.
9. **Vacancies / collab** — same handoff pattern as Moxito SMM block.
10. **Photo** — when needed for design/medical; otherwise don’t invent «send photo to confirm booking» for non-client funnels.

## Suggested section order

Context → temporary/Stories rules → style → message analysis → service clarification → booking tools → CRM → combos → handoff → forbidden list.

## Example first-reply shape

«Вітаю[, імʼя]! Я <Name>, AI-асистент <Brand>… Якщо потрібна людина — напишіть **admin**.» + substance in the same message.
