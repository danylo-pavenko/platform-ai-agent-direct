---
name: tenant-first-prompt
description: >-
  Draft or improve a tenant Instagram DM system prompt for
  platform-ai-agent-direct and save the .txt under docs/prompts/ (gitignored).
  Use when onboarding a tenant, «перший промпт», generate/update/improve prompt,
  Moxito-style booking, product/ecom, leadgen/software (chip tuning, прошивки),
  or adapting apps/workspace/templates/prompts/*.txt. Always write results to
  docs/prompts/, never commit those .txt files unless the user explicitly asks.
---

# Tenant first prompt (platform-ai-agent-direct)

Build or improve a **tenant system prompt** for Admin → Навчання агента.

This is **not** the repo root `CLAUDE.md` and **not** `apps/workspace/templates/CLAUDE.md`.

## Output location (mandatory)

| Path | Git |
|------|-----|
| `docs/prompts/<slug>-system-prompt-vX.Y.txt` | **Ignored** (local only) |
| `docs/prompts/README.md` | Tracked |

**Always** write the finished `.txt` into `docs/prompts/`. Create the directory if missing.

Do **not** write working drafts to `scratch/` (except when the user explicitly wants a committed gold example). Do **not** `git add` files under `docs/prompts/*.txt`.

### Naming

```text
docs/prompts/<tenant-slug>-system-prompt-v<major>.<minor>.txt
```

- New tenant → `v1.0`
- Improve existing → bump minor (`v1.18` → `v1.19`) or major if funnel/mode changes; keep prior file on disk unless the user asks to replace

## When to use

- New tenant / first activate
- «Згенеруй промпт», «покращ промпт», «онови промпт»
- Rewrite seed template into brand voice
- User names salon, ecom, «прошивки», chip tuning, leadgen, sales, booking

## Modes

### A) Generate (first prompt)

1. Gather inputs (table below) — skip what the user already gave.
2. Confirm archetype + mode + language.
3. Read references + seed (see Source of truth).
4. Draft **v1.0** with the skeleton.
5. Write `docs/prompts/<slug>-system-prompt-v1.0.txt`.
6. Remind: paste into Admin → activate; do not commit the txt; platform capabilities stay injected by the runtime.

### B) Improve / update

1. Locate the current prompt: path the user gave, or latest matching `docs/prompts/<slug>-system-prompt-v*.txt`, or a paste in chat.
2. Read it fully. Ask what to change if unclear (Stories, handoff, CRM honesty, tone, new services).
3. Apply changes; add a **Changelog** bullet for this version.
4. Write **new** file with bumped version under `docs/prompts/` (prefer keep old file).
5. Summarize what changed in 3–6 bullets for the user.

## Inputs to gather (ask once if missing)

| Field | Why |
|-------|-----|
| Brand name + agent persona name | Greeting / «Я …» |
| Archetype | `service` \| `product` \| `software` \| mix |
| Agent mode | `booking` \| `sales` \| `leadgen` \| `general` |
| City / address / map / phone / IG / site | Context block |
| Working hours + timezone | Hours + SLA wording |
| Language / «Ви» vs «ti» | Tone |
| CRM (BeautyPro / CleverBOX / Altegio / KeyCRM / none) | Which tools matter |
| Top 5–15 services or product categories | Clarification rules |
| Handoff triggers (refund, complaint, courses, B2B) | Escalation |
| Stories / ads special cases | Non-booking paths |
| Forbidden claims | Legal / medical / dyno / guarantees |

If mode is unclear: salon → `booking`; shop → `sales`; consult/tune/agency → `leadgen` or `general`.

## Source of truth (read before inventing)

1. **Gold structure (service):** newest `scratch/moxito-system-prompt-v*.txt` in repo — sectioning only; or a prior draft in `docs/prompts/` for that tenant.
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

## Output skeleton (required sections)

Use Moxito-like headings; drop sections that do not apply.

```text
# СИСТЕМНИЙ ПРОМПТ: <BRAND> — AI-АГЕНТ «<NAME>»
## Version X.Y — Instagram DM

### Changelog
- vX.Y: …

Ти — <persona>. Завдання — <one sentence outcome>.

Головний пріоритет — <heard / accurate / no pressure / no fake success>.

## ═══ КОНТЕКСТ ПРО БІЗНЕС ═══
— назва, адреса, телефон, графік, сайт, Instagram

## Тон і вітання
— Ви/ти, мова, довжина DM, емодзі
— Скопіюй блок «Вітання» нижче дослівно в кожен новий промпт і підстав лише фрази та часовий пояс тенанта. Не скорочуй його до «привітайся один раз».

### Вітання (обов'язковий блок тенант-промпту)

Платформа сама ставить позначку. Агент слухається її, а не здогадується по старих повідомленнях. Три гілки, усі три мають бути в тексті промпту своїми формулюваннями:

1. «Це ПЕРША відповідь бота в цій розмові» або «нова сесія» після довгої тиші: у тій самій репліці коротке вітання, ім'я і роль зі промпту, потім одразу відповідь. Окреме «привіт» без справи не пиши.
2. «Почався новий календарний день» або рядок історії «Новий календарний день салону»: перша відповідь цього дня обов'язково починається з короткого вітання мовою клієнта і в тій самій репліці переходить до відповіді. Вчорашні повідомлення вітання не скасовують. Повне представлення не повторюй, якщо промпт цього не просить. Вже відомі факти не перепитуй.
3. «Бот уже відповідав у цьому календарному дні» або поточне оформлення замовлення: не вітатися знову. На «добрий ранок» відповісти по суті, без дзеркального «Доброго дня» і без повторного імені.

Дай готові перші рядки трьома мовами, якщо тенант їх обслуговує. Часовий пояс дня візьми з `agent_config.timezone`, не з сервера.

Без цього блоку модель бачить вчорашній чат і пропускає вітання: платформа лише дозволяє привітатись, якщо промпт тенанта прямо просить.

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

Prefer **150–350 lines** for v1.0; grow only when the tenant hit real edge cases.

## Quality bar

- Facts only from user/brief; unknowns → handoff, not invention.
- Tool success honesty (book / collect_order / reschedule).
- No internal UUID / product_id / service_id in customer copy.
- Greeting: first reply introduces; each new salon civil day greets again when the runtime marks it; no re-greet the same day.
- Special Stories/ads paths never become the wrong funnel.
- Never stage or commit `docs/prompts/*.txt` unless the user explicitly demands it.

## Anti-patterns

| Don't | Do |
|-------|-----|
| Save drafts only in chat | Write `docs/prompts/…txt` |
| `git add docs/prompts/*.txt` | Leave local |
| Dump `platform-capabilities-prompt.ts` into tenant prompt | Name tools + tenant policy |
| Clone Moxito manicure rules for chip-tuning | Use software archetype |
| Promise book/order without tool ok | Gate on tool result |

## After draft

Give the absolute path to the `.txt` and a short activate checklist: mode, CRM routing, working hours, paste into Admin, sandbox happy-path + handoff.
