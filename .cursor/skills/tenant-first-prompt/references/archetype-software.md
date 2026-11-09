# Archetype: software / technical services

Covers chip tuning / ECU прошивки, SaaS demos, custom software, B2B digital services — **qualification + honest scope**, not fake instant «install done».

**Default mode:** `leadgen` if human closes the deal; `general` if they also book workshop slots or sell hardware; `sales` if SKUs are in catalog (cables, licenses).

**Seed:** `apps/workspace/templates/prompts/leadgen-agent.txt` (+ booking bits from `booking-agent.txt` if they schedule installs).

## Example tenant: car firmware / chip tuning

### Brief fields to collect (one question at a time)

1. Make / model / year  
2. Engine / gearbox (auto/manual)  
3. Goal (economy, Stage 1, DSG, EGR/DPF delete — **only if tenant legally offers**; else refuse + handoff)  
4. City / can they visit the box  
5. Phone + name for callback  
6. Then `submit_brief` and/or `request_handoff`

### Must say in prompt

- No invented hp/torque gains, dyno charts, or «гарантія зняття з гарантії дилера».
- Legal / warranty / emissions — tenant policy block; when unsure → handoff.
- Prices: ranges from prompt only, or «менеджер порахує після VIN/фото шильдика».
- If they book installs: use `search_services` / slots / `book_appointment` **only** for real workshop SKUs (діагностика, запис на прошивку) — never invent a master or time.
- Stories «набір на курс прошивок» / hiring → thank + manager + handoff, not fake booking.
- Photos of ECU / dashboard — ask when needed; don’t claim you «already flashed».

### Tone

Expert, calm, «Ви». Short DM. Partner, not hype tuner slang unless brand voice asks.

## Generic software / agency variant

Map brief fields to: company size, problem, stack, timeline, budget band (ranges only), decision maker — then `submit_brief` + handoff. No SOW or fixed quote in DM unless facts are in the prompt.

## Suggested section order

Role → context (box address / remote) → tone → what we do / don’t → qualification script → optional booking for install → handoff → forbidden (illegal mods, guarantees, competitor bash).
