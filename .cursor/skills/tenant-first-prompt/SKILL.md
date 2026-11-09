---
name: tenant-first-prompt
description: >-
  Draft the first production system prompt for a new platform-ai-agent-direct
  tenant (Instagram DM AI). Use whenever onboarding a tenant, writing v1.0
  prompt, «перший промпт», Moxito-style booking prompt, product/ecom sales
  prompt, leadgen/software (chip tuning, прошивки, B2B services), or adapting
  apps/workspace/templates/prompts/*.txt into a brand-specific Admin prompt.
  Prefer this over inventing a prompt from scratch.
---

# Tenant first prompt (platform-ai-agent-direct)

Build a **tenant system prompt** ready to paste into Admin → Навчання агента
(or save under `scratch/<slug>-system-prompt-v1.0.txt`). This is **not** the
repo root `CLAUDE.md` and **not** `apps/workspace/templates/CLAUDE.md`.

## When to use

- New tenant / first activate
- Rewrite seed template into brand voice
- User names Moxito, salon, ecom, «прошивки», chip tuning, leadgen, sales, booking

## Inputs to gather (ask once if missing)

Collect before drafting. Skip what the user already gave.

| Field | Why |
|-------|-----|
| Brand name + agent persona name | Greeting / «Я …» |
| Archetype | `service` \| `product` \| `software` \| mix |
| Agent mode | `booking` \| `sales` \| `leadgen` \| `general` |
| City / address / map / phone / IG / site | Context block |
| Working hours + timezone | Hours + SLA wording |
| Language / «Ви» vs «ти» | Tone |
| CRM (BeautyPro / CleverBOX / Altegio / KeyCRM / none) | Which tools matter |
| Top 5–15 services or product categories | Clarification rules |
| Handoff triggers (refund, complaint, courses, B2B) | Escalation |
| Stories / ads special cases | Non-booking paths |
| Forbidden claims | Legal / medical / dyno / guarantees |

If mode is unclear: salon → `booking`; shop → `sales`; consult/tune/agency → `leadgen` or `general`.

## Source of truth (read before inventing)

1. **Gold structure (service):** `scratch/moxito-system-prompt-v1.18.txt` (or newest `scratch/moxito-system-prompt-v*.txt`) — sectioning, greeting discipline, tool honesty, Stories/handoff patterns.
2. **Seed templates:** `apps/workspace/templates/prompts/`
   - `booking-agent.txt` — salon tools + flows
   - `sales-agent.txt` / `sales-agent-ig-dm.txt` — catalog + order
   - `leadgen-agent.txt` — brief + handoff
   - `general-agent.txt` — union of intents
3. **Platform hard rules:** [references/platform-rules.md](references/platform-rules.md)
4. **Archetype outlines:**
   - [references/archetype-service.md](references/archetype-service.md)
   - [references/archetype-product.md](references/archetype-product.md)
   - [references/archetype-software.md](references/archetype-software.md)

Do **not** copy Moxito prices, masters, or address into another tenant. Copy **patterns**, not facts.

## Workflow

1. Confirm archetype + mode + language.
2. Read the matching archetype reference + `platform-rules.md`.
3. Skim the matching seed template for tool names; skim Moxito only for service-shaped prompts.
4. Draft **v1.0** in Ukrainian (unless tenant is EN-first) with the skeleton below.
5. Write file: `scratch/<tenant-slug>-system-prompt-v1.0.txt`.
6. Tell the user: paste into Admin → activate; platform capabilities are injected separately — do not paste `platform-capabilities-prompt.ts` into the tenant prompt.
7. Commit/push only if the user asks.

## Output skeleton (required sections)

Use Moxito-like headings; drop sections that do not apply.

```text
# СИСТЕМНИЙ ПРОМПТ: <BRAND> — AI-АГЕНТ «<NAME>»
## Version 1.0 — Instagram DM

### Changelog
- v1.0: first production prompt for <brand> (<archetype>, mode=<mode>).

Ти — <persona>. Завдання — <one sentence outcome>.

Головний пріоритет — <heard / accurate / no pressure / no fake success>.

## ═══ КОНТЕКСТ ПРО БІЗНЕС ═══
— назва, адреса, телефон, графік, сайт, Instagram

## Тон і вітання
— Ви/ти, мова, довжина DM, емодзі
— Перше вітання + хто ти + як кликнути людину (admin / менеджер)
— Без повторного «Вітаю / Я …» того ж календарного дня

## Аналіз повідомлень
— реакції без тексту → мовчати
— серія бульбашок → одна відповідь
— Stories / пости / вакансії / спец-воронки

## Уточнення (домен)
— мінімум питань до tool
— готові пакети / SKU / бриф-поля

## Основний flow + tools
— лише назви tools режиму; ніколи «викликай CRM API»
— не стверджуй успіх без ok від tool

## Handoff
— коли request_handoff; коли show_to_client=true

## Заборони
— нумерований список (ids клієнту, вигадані ціни, fake book/order, …)
```

Fill domain rules from the archetype file. Keep the first prompt **usable**, not encyclopedic — prefer 150–350 lines; put rare edge cases only if the tenant already hit them.

## Quality bar

- Facts only from user/brief; unknowns → handoff, not invention.
- Tool success honesty (book / collect_order / reschedule).
- No internal UUID / product_id / service_id in customer copy.
- Greeting once per salon civil day (platform also injects day hints).
- Special Stories/ads paths never silently become the wrong funnel (e.g. courses → manager, not salon book).
- Placeholders `{{BRAND_NAME}}`, `{{WORKING_HOURS_SUMMARY}}`, `{{MANAGER_SLA_HOURS}}` only if the tenant still uses template injection; brand-specific prompts usually hardcode real values.

## Anti-patterns

| Don't | Do |
|-------|-----|
| Dump entire `platform-capabilities-prompt.ts` into tenant prompt | Name tools + tenant policy only |
| Clone Moxito manicure checklist for a chip-tuning shop | Use software archetype brief fields |
| Promise «записала / замовлення оформлено» without tool ok | Gate on tool result |
| Mix sales catalog tools into pure booking without `general` mode | Match Admin agent mode |
| Write English commit-style headings inside UA customer policy | Match tenant language |

## After draft

Offer a 5-line activate checklist: mode in Settings, CRM routing, working hours, paste prompt, sandbox one happy-path + one handoff.
