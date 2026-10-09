# Direct AI Agents — Ideal Customer Profile (ICP), Buyer Personas (BP), Feature List & Use Cases

**Product:** Multitenant SaaS — AI agent for Instagram Direct (sales, lead gen, booking). Dedicated EU instance per brand; CRM / Telegram handoff.  
**Launch SLAs:** Platform go-live typically **~48 hours**. **CRM integration from 24 hours** (existing connectors; credentials + routing ready).  
**CRM stack:** KeyCRM, BeautyPro (Beauty / Fitness / Denta Pro), CleverBOX; **Altegio** (booking CRM — on the roadmap / rolling out).  
**Document use:** Qualify leads, prioritize outbound, align sales + marketing, demo scripting.  
**Audience of this doc:** Founders, sales, partnerships, CS.

---

## 1. How to use this document (process)

| Step | Action | Output |
|------|--------|--------|
| 1 | Score the account against **ICP Must-haves** | Fit: Strong / Partial / No |
| 2 | Identify primary **Buyer Persona** + economic buyer | Talk track + objections |
| 3 | Confirm **Buying triggers** present | Timing: Now / Warm / Later |
| 4 | Map **Decision unit** (who signs, who blocks) | Stakeholder plan |
| 5 | Pick **agent mode** + CRM from Feature List | Demo script / pilot scope |
| 6 | Walk **Use Case** matching their segment | Proof in sandbox or live Debug |
| 7 | Choose offer path (trial / paid deploy) | Next meeting agenda |
| 8 | Disqualify early if **Anti-ICP** matches | Do not spend cycle |

---

## 2. Market definition

| Dimension | Scope |
|-----------|--------|
| **Category** | Conversational commerce / Instagram DM automation for SMBs & mid-market brands |
| **Primary channel** | Instagram Business + Facebook Page (Messenger Platform) |
| **Core jobs** | Reply 24/7; qualify; sell or book; hand off to humans; sync CRM |
| **Geo (current GTM)** | Ukraine-first (UA language, Nova Poshta, local CRM); EU-hosted; expandable where Meta + CRM fit |
| **Not competing with** | Generic website chatbots, WhatsApp-only suites, pure CRM without IG DM agent |

---

## 3. Ideal Customer Profile (ICP) — company level

### 3.1 Firmographics

| Attribute | Ideal | Acceptable | Out of scope |
|-----------|--------|------------|--------------|
| **Business model** | D2C / brand selling via Instagram; or multi-location beauty/fitness/dental with online booking | Hybrid: IG + site | Pure B2B with no IG consumer demand |
| **Industry** | Fashion / apparel / beauty retail; beauty salons, barbers, fitness, dental (booking CRM) | Home goods, niche e-com with catalog in IG | Heavy regulated advice (medical diagnosis, legal) without human gate |
| **Size** | 1–3 owners + 1–10 ops/sales staff; or salon network 1–15 locations | Growing teams with IG as main sales channel | Enterprise omnichannel needing custom SLA/legal only |
| **IG maturity** | Active Business/Creator IG linked to FB Page; regular inbound DMs | Seasonal peaks but real DM volume | Personal IG only; no Page; no Advanced Access path |
| **Revenue signal** | Missed DMs = lost orders/bookings; hiring or overtime on chat | Planning first hire for chat | “Just curious about AI”, no volume |
| **Tech readiness** | Willing to connect Meta OAuth; CRM (KeyCRM / BeautyPro / CleverBOX / **Altegio**) or Telegram ops | Telegram-only handoff at start | Refuse Meta permissions / no admin access to BM |

### 3.2 Technographics

| Must | Preferred | Optional |
|------|-----------|----------|
| Instagram Business + FB Page under Business Manager | KeyCRM **or** BeautyPro/FitnessPro/DentaPro **or** CleverBOX **or** Altegio | Nova Poshta for UA shipping flows |
| Owner/admin who can complete Meta App Live / Advanced Access | Dedicated ops person for prompts & catalog | Multiple IG assets later |
| Acceptance of dedicated tenant (isolated instance) | Existing product catalog / service price list | Voice notes (STT), follow-ups |

### 3.3 Behavioral / psychographic (company)

- Treats Instagram DM as a **revenue channel**, not a FAQ widget.
- Feels latency pain: clients expect minutes, staff answers hours later.
- Wants **brand-owned** automation (own prompts, knowledge, not a shared generic bot).
- Accepts AI with human escalation (Telegram handoff), not “full autopilot forever”.
- Can dedicate 1–2 hours for onboarding (OAuth, catalog/CRM, prompt review).

### 3.4 ICP scorecard (use in discovery)

Give **+2 / +1 / 0 / −2** per row. **Strong fit ≥ 10**. **No go ≤ 3** or any hard disqualifier.

| Criterion | +2 | +1 | 0 | −2 |
|-----------|----|----|---|----|
| Daily inbound DMs | High, sales/booking intent | Moderate | Low / vanity | Almost none |
| IG + Page ready | Live, messaging works | Fixable in 1 week | Unclear BM | Personal account only |
| Economic buyer engaged | Owner/CEO in call | Ops with budget path | Marketer only | No decision path |
| CRM / ops sink | CRM or Telegram ops | Telegram only | Spreadsheet | Nothing, won’t adopt |
| Catalog / services clear | Structured SKU/services | Semi-structured | Ad-hoc | “We’ll invent later” |
| Compliance appetite | OK with Meta review + EU host | Needs guidance | Resistant | Blocks permissions |

**Hard disqualifiers (stop):** no Instagram Business path; expects WhatsApp-only; wants free forever without trial discipline; medical/legal advice without handoff; refuses isolated tenant / data model.

---

## 4. Buyer Personas (BP) — people who buy and run it

### BP-1 — Economic Buyer: “Owner / Founder”

| Field | Detail |
|-------|--------|
| **Role** | Founder, co-owner, salon/network owner |
| **Goal** | More closed orders/bookings without proportional headcount |
| **Pain** | Night/weekend DMs lost; managers overloaded; inconsistent answers |
| **Success metric** | % dialogs without manager; response time; orders/bookings from IG |
| **Budget authority** | Yes (monthly + setup) |
| **Objections** | “Will AI mess up brand?”; “Meta permissions”; price vs junior hire |
| **Message** | Isolated instance, prompt control, handoff, measurable attach rate |
| **Ask** | Pilot month → review metrics → convert |
| **Demo focus** | End-to-end order or booking + Telegram card |

### BP-2 — Champion / Operator: “Head of Sales / Salon Admin / Community Manager”

| Field | Detail |
|-------|--------|
| **Role** | Runs IG chats daily or manages the team that does |
| **Goal** | Fewer repetitive chats; clean handoff; CRM without retyping |
| **Pain** | Copy-paste answers; missed sizes/addresses; double-booking; night shifts |
| **Success metric** | Time saved; fewer errors; fewer escalations for routine asks |
| **Budget** | Influences; rarely signs alone |
| **Objections** | “Another tool to babysit”; prompt quality; CRM edge cases |
| **Message** | Admin Settings, Teach/Sandbox, CRM tools, manager Telegram cards |
| **Ask** | Co-own prompt + catalog; weekly review first 2 weeks |
| **Demo focus** | Sandbox replay; unfinished booking funnel; handoff SLA |

### BP-3 — Technical Gate: “IT / Digital / Agency”

| Field | Detail |
|-------|--------|
| **Role** | Internal IT, freelance Meta specialist, performance agency |
| **Goal** | Stable webhooks, OAuth, no brand-safety incidents |
| **Pain** | Broken webhooks; App Review; multiple tenants/domains |
| **Success metric** | Uptime; correct routing; Advanced Access approved |
| **Budget** | Blocks or unblocks; rarely pays |
| **Objections** | Scopes, Live mode, shared vs dedicated Meta app |
| **Message** | Documented Meta flow, hub routing, EU host, supervisor deploy |
| **Ask** | One working OAuth + webhook proof before go-live |
| **Demo focus** | Settings → Meta; health; Debug whitelist |

### BP-4 — Blocker (manage, don’t sell as primary): “Senior Master / Star Seller”

| Field | Detail |
|-------|--------|
| **Role** | Top closer who fears AI replaces them |
| **Risk** | Sabotages prompts; insists all chats stay human |
| **Handle** | Position AI as first line + their close on high-value; show handoff SLA |

---

## 5. Buying committee (typical)

```
Economic buyer (Owner) ── signs
        ▲
Champion (Ops / Admin) ── runs day-to-day
        ▲
Tech gate (IT / Agency) ── Meta + CRM
```

**Minimum to close:** Owner + Champion on one call; Tech available for OAuth week.

---

## 6. Buying triggers (timing)

Pursue when ≥1 is true:

1. IG ads or organic spike → DM backlog.
2. Hiring for “chat manager” or overtime on Direct.
3. Opening new salon / SKU line → can’t scale answers.
4. CRM already live; data re-entry from IG is painful.
5. Competitors reply faster in DM; conversion drop.
6. Explicit request: “AI for Instagram / booking bot”.

Delay when: Meta asset not owned; rebrand/BM migration mid-flight; no one owns catalog quality.

---

## 7. Feature list (product capabilities)

Grouped for GTM. Internal detail: `docs/AGENT_RUNTIME.md`, admin Settings.

### 7.1 Agent runtime (customer-facing)

| Feature | What it does |
|---------|----------------|
| **Agent modes** | `sales` / `leadgen` / `booking` / `general` (union of the three) — different tools + prompts |
| **Instagram DM automation** | Inbound webhooks → Claude → outbound DM; long replies split; Markdown stripped for IG |
| **Typing indicator** | `typing_on` while generating |
| **Inbound coalesce** | Rapid bubbles (time + name + phone) merged into one turn |
| **Working hours + out-of-hours** | Tenant timezone; warn early or defer |
| **Reply delay** | Optional human-like pause 0–60s |
| **Smart-trigger (follow-up)** | If client silent after bot message (default 18h, max 24h) → one contextual nudge inside Meta 24h window |
| **Handoff** | Keyword + AI escalation; Telegram escalation card; SLA reminder; bot can return after TTL |
| **Manager Instagram echo** | Native IG app replies labeled in admin; bot stops (handoff), no Claude on echo |
| **Vision** | Product photos, payment screenshots, Story reply frames (when CDN available) |
| **Shared posts / reels** | Attachment parse + catalog match |
| **Reactions & Stories** | Context for agent; Story reply with vision when possible |
| **Voice (optional)** | STT for voice notes when enabled |
| **Session freshness** | Stale threads close after N days; new conversation UUID |
| **Debug / Public runtime** | Whitelist-only replies in Debug for safe go-live |

### 7.2 Sales (e-commerce)

| Feature | What it does |
|---------|----------------|
| **Catalog search** | Live CRM catalog and/or file/CSV (e.g. Shop-Express); design/SKU-aware matching |
| **Delivery cost** | Nova Poshta `get_delivery_cost` |
| **Order collection** | `collect_order` (full e-com data) / `create_local_order` (soft consent) — always local DB |
| **CRM mirror** | Optional KeyCRM write when enabled |
| **Shipment / TTN lookup** | Order status + tracking from KeyCRM; Nova Poshta fallback by TTN/phone |
| **Payment requisites** | Admin button / agent path for IBAN/card copy |

### 7.3 Lead generation

| Feature | What it does |
|---------|----------------|
| **Intent classify** | Route to sales/booking/brief paths in leadgen/general |
| **Brief submit** | Structured brief → local + Telegram (+ KeyCRM lead if write on) |

### 7.4 Booking (salon / fitness / dental)

| Feature | What it does |
|---------|----------------|
| **Service search** | Live services + categories from BeautyPro / CleverBOX / Altegio (when connected) |
| **Available slots** | Free-time windows; master preference from history; multi-service / staggered starts |
| **Book / cancel / reschedule** | CRM appointments; remove one service line; no “second book” as move |
| **Client link** | Phone / CRM UUID / history; `lookup_client_by_phone`, visit history |
| **Branches** | Multi-location when configured |
| **Late arrival notify** | Client “running late” → manager Telegram |
| **Reference photo** | Attach look reference for masters |
| **Grade / position prices** | BeautyPro master-grade price quotes in slots |
| **Unfinished booking funnel** | Resume after pause (~36h) without restarting search |
| **Schedule guards** | Refuse book when master day closed or slot not in free_time |

### 7.5 CRM & integrations

| Provider | Capabilities |
|----------|----------------|
| **KeyCRM** | Catalog, orders, leads, client upsert, shipment/TTN |
| **BeautyPro** (Beauty / Fitness / Denta Pro) | Locations, services, free_time, appointments, clients, history |
| **CleverBOX** | Services, branches, booking |
| **Altegio** | Booking CRM for beauty / wellness networks — services, schedule, appointments (rolling out alongside existing adapters) |
| **Hybrid routing** | e.g. catalog/orders → KeyCRM; booking → BeautyPro / CleverBOX / Altegio |
| **CRM integration SLA** | **From 24 hours** when credentials and routing are ready (standard connectors). Full tenant go-live (Meta + prompts + CRM) remains typically ~48 hours. |
| **Telegram** | Multi-bot notify: orders, briefs, bookings, handoff, late client |
| **Nova Poshta** | Delivery cost + TTN lookup |
| **Meta OAuth** | Page token + IG messaging; hub redirect for platform tenants |

### 7.6 Tenant admin (operator)

| Feature | What it does |
|---------|----------------|
| **Conversations** | Search, filters, live poll, client profile, CRM link, tags |
| **Orders** | Status, manager actions, CRM deep links, retry sync |
| **Prompts** | Versioned system prompts; activate / rollback |
| **Teach (meta-agent)** | Natural-language prompt edits with apply |
| **Sandbox** | IG-style test chat; saved cases; dry-run writes |
| **Insights (AI assistant)** | Metrics + config + confirm-gated ops tools (no IG outbound) |
| **Settings** | Mode, SLA, timezone, auto-update, Meta, CRM routing, Telegram, NP, runtime mode |
| **Sync** | Manual CRM sync + history |
| **Isolation** | Dedicated Linux user, DB, knowledge dir, domains |

### 7.7 Platform / Super Admin (ops)

| Feature | What it does |
|---------|----------------|
| **Webhook hub** | Single HTTPS callback → route by IG/Page id to tenant |
| **Provision / Deploy / Destroy** | Tenant lifecycle; deploy logs SSE; workers on remote VPS |
| **Midnight auto-update** | Tenant polls SA `VERSION.code` → requests Deploy (toggle in Settings) |
| **Access control** | Tenant admin access expiry / suspend from hub |
| **Health** | PM2 / Claude auth & usage checks |

---

## 8. Use cases (examples)

Each case: **who** → **flow** → **outcome** → **demo tip**.

### UC-1 — Fashion brand: DM → order → KeyCRM + Telegram

| | |
|--|--|
| **ICP fit** | D2C apparel; KeyCRM; high IG DM volume |
| **Mode** | `sales` or `general` |
| **Flow** | Client asks size/color → `search_catalog` → quotes price → collects name, phone, city, NP branch, payment → `collect_order` → local Order + optional KeyCRM + Telegram card |
| **Outcome** | Order without manager typing; manager packs/ships from CRM/Telegram |
| **Demo tip** | Shared reel → vision + catalog match → full collect |

### UC-2 — “Where is my parcel?”

| | |
|--|--|
| **ICP fit** | Same brand post-purchase support |
| **Mode** | `sales` / `general` |
| **Flow** | Client sends phone or TTN → `lookup_order_shipment` (KeyCRM, else Nova Poshta) → status in DM |
| **Outcome** | Fewer “де посилка?” handoffs |
| **Demo tip** | Use a real test TTN owned by the brand; never reveal third-party TTN |

### UC-3 — Beauty salon: book manicure with preferred master

| | |
|--|--|
| **ICP fit** | BeautyPro salon; repeat clients |
| **Mode** | `booking` or `general` |
| **Flow** | Phone → `lookup_client_by_phone` / history → `search_services` → `get_available_slots` (preferred `master_id` if same service type) → confirm → `book_appointment` → CRM planned visit + Telegram |
| **Outcome** | Visit in BeautyPro without admin UI; client gets confirmation in DM |
| **Demo tip** | Show grade prices; refuse closed master day |

### UC-4 — Multi-service visit (hair + brows, staggered)

| | |
|--|--|
| **ICP fit** | Multi-master salon |
| **Mode** | `booking` |
| **Flow** | Two services, different masters → slots with per-line `master_id` / `start_time` → single `book_appointment` |
| **Outcome** | One visit, correct timeline in CRM |
| **Demo tip** | Contrast parallel vs sequential starts |

### UC-5 — Reschedule / cancel / remove one service

| | |
|--|--|
| **ICP fit** | Any booking tenant |
| **Mode** | `booking` / `general` |
| **Flow** | Client changes plans → `reschedule_appointment` / `cancel_appointment` / `remove_appointment_service` (not a second book as “move”) |
| **Outcome** | CRM state correct; refund still → handoff |
| **Demo tip** | Explicitly show wrong path (second book) is refused by policy |

### UC-6 — Unfinished booking overnight

| | |
|--|--|
| **ICP fit** | Clients who drop mid-funnel |
| **Mode** | `booking` |
| **Flow** | Slots offered at 23:00; client sends phone at 01:00 → funnel inject → book with stored ids |
| **Outcome** | No “start over”; higher completion |
| **Demo tip** | Sandbox pause between slot pick and contacts |

### UC-7 — Lead gen: campaign DM → brief

| | |
|--|--|
| **ICP fit** | Agency / high-ticket consult; KeyCRM leads |
| **Mode** | `leadgen` |
| **Flow** | Qualify need/budget/timeline → `submit_brief` → Telegram + optional KeyCRM lead |
| **Outcome** | Sales gets structured brief, not raw chat |
| **Demo tip** | Show brief fields vs free-form DM |

### UC-8 — Handoff: angry client / refund

| | |
|--|--|
| **ICP fit** | All segments |
| **Mode** | any |
| **Flow** | Conflict or refund → `request_handoff` → one Telegram escalation card; bot quiet; manager replies in IG or admin |
| **Outcome** | Brand-safe escalation; SLA ping if manager late |
| **Demo tip** | Manager reply from Instagram app → `ig_native_echo` in admin |

### UC-9 — Night silence → soft follow-up

| | |
|--|--|
| **ICP fit** | Sales/booking with soft closes |
| **Mode** | any with Smart-trigger on |
| **Flow** | Bot asked a question; client silent 18h → one agent follow-up inside Meta window |
| **Outcome** | Recover abandoned carts/bookings without spam templates |
| **Demo tip** | Show Settings: delay hours + timezone |

### UC-10 — Multi-branch network

| | |
|--|--|
| **ICP fit** | 2+ locations |
| **Mode** | `booking` / `general` |
| **Flow** | Client picks branch → `set_conversation_branch` → slots/book scoped to location |
| **Outcome** | Correct salon calendar |
| **Demo tip** | Two branches with different free_time |

### UC-11 — Safe launch (Debug whitelist)

| | |
|--|--|
| **ICP fit** | First go-live |
| **Mode** | any + **Debug** runtime |
| **Flow** | Only whitelisted IG handles get bot replies; then switch **Public** |
| **Outcome** | No accidental public AI before prompt QA |
| **Demo tip** | BP-3 / BP-2 joint checklist |

### UC-12 — Hybrid CRM: KeyCRM catalog + BeautyPro booking

| | |
|--|--|
| **ICP fit** | Brand that also runs a studio |
| **Mode** | `general` + `crm_routing` by_action |
| **Flow** | Product questions → KeyCRM catalog/order; appointment → BeautyPro |
| **Outcome** | One IG agent, two backends |
| **Demo tip** | Routing table in Settings |

### UC-13 — Altegio salon network: CRM connect in ≥24h

| | |
|--|--|
| **ICP fit** | Beauty / wellness chain already on Altegio |
| **Mode** | `booking` / `general` |
| **Flow** | Provide Altegio credentials → platform wires routing (**CRM integration from 24 hours**) → Meta + prompts → services/slots/book in DM |
| **Outcome** | Same booking UX as BeautyPro path; schedule lives in Altegio |
| **Demo tip** | Separate SLA: CRM hookup ≥24h vs full go-live ~48h |

---

## 9. Value propositions by ICP segment

| Segment | Primary value | Proof to show |
|---------|---------------|---------------|
| **E-com / brand (sales)** | Catalog-aware DM → order → Telegram + KeyCRM | UC-1, UC-2 |
| **Salon / fitness / dental (booking)** | Services, slots, book/cancel/reschedule (BeautyPro, CleverBOX, Altegio) | UC-3–UC-6, UC-10 |
| **Lead gen** | Qualify + brief to managers | UC-7 |
| **All** | 24/7 first line + human escalation | UC-8, UC-9, UC-11 |

---

## 10. Qualification script (15 minutes)

1. **Volume:** How many sales/booking DMs per day (not likes)?  
2. **Channel:** IG Business + Page — who owns BM?  
3. **Outcome:** Sell products, book visits, or both?  
4. **Sink:** KeyCRM / BeautyPro / CleverBOX / Altegio / Telegram only?  
5. **Owner:** Who pays monthly and who edits answers?  
6. **Timeline:** When must first live reply ship?  
7. **Constraint:** Any “AI must never…” rules?

**Pass:** Clear volume + owner + Meta path + sink.  
**Hold:** Volume OK, Meta broken → fix Meta first.  
**Fail:** No DM revenue intent or hard disqualifier.

---

## 11. Anti-ICP (do not pursue)

- Expectation: replace Meta App Review / Business Manager work with “magic connect”.
- Only need comment auto-replies / Story stickers without DM sales loop.
- Want one shared bot for many unrelated brands without isolation.
- Primary channel is WhatsApp/Viber; Instagram is vanity.
- No willingness to review prompts or catalog after go-live.

---

## 12. One-line ICP (internal)

> **Ukrainian (and similar) Instagram-native brands and appointment businesses that already receive sales or booking DMs, can connect Meta + a CRM or Telegram ops sink, and will pay for a dedicated AI agent instance to convert Direct traffic 24/7 with human escalation.**

---

## 13. One-line personas (internal)

| ID | Line |
|----|------|
| BP-1 Owner | Buys speed-to-revenue and headcount leverage. |
| BP-2 Operator | Buys fewer repetitive chats and cleaner handoffs. |
| BP-3 Tech | Buys a Meta/CRM setup that doesn’t break. |
| BP-4 Star seller | Needs role preserved as escalated closer. |

---

## 14. Demo agenda (30 minutes)

| Min | Topic | Owner |
|-----|--------|--------|
| 0–3 | ICP confirm (volume, mode, CRM) | Sales |
| 3–8 | Architecture: dedicated tenant + Meta | Tech / Sales |
| 8–18 | Live use case (UC-1 or UC-3) | Champion watches |
| 18–23 | Handoff + admin (UC-8) | Ops |
| 23–27 | Teach / Sandbox / Debug launch | Ops |
| 27–30 | Pilot scope, timeline, next step | Economic buyer |

---

*Source of truth for runtime behavior: code + `docs/AGENT_RUNTIME.md`. Update this file when modes, CRM, or GTM positioning change.*
