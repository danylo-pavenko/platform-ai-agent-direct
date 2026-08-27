# Agent runtime — what lives inside the system

Canonical map of the Instagram DM AI agent for this platform: spawn model, prompt layers, tools, CRM, admin assistants, and performance constraints.

**Source of truth in code** (keep in sync when changing tools/CRM/modes):

| Concern | Path |
|---------|------|
| Modes + tool schemas | `apps/backend/src/lib/tool-definitions.ts` |
| Tool instructions in prompt | `apps/backend/src/lib/agent-tools-prompt.ts` |
| Platform map (modes/CRM/tools) | `apps/backend/src/lib/platform-capabilities-prompt.ts` |
| Claude CLI spawn | `apps/backend/src/services/claude.ts` |
| Customer turn orchestration | `apps/backend/src/services/conversation.ts` |
| Runtime prompt composition | `apps/backend/src/services/prompt-builder.ts`, `prompt-runtime.ts` |
| Multi-CRM routing | `apps/backend/src/lib/crm-routing.ts`, `docs/MULTI_CRM_INTEGRATION_GUIDE.md` |
| Tenant seed knowledge | `apps/workspace/templates/` |

Claude invocation = **headless Claude Code CLI / Agent SDK** (`query()` default, `claude -p` hotfix), **not** the Anthropic Messages API.

---

## End-to-end customer turn

```mermaid
flowchart TD
  A[Meta IG webhook] --> B[webhooks.ts]
  B -->|200 OK immediate| C[inbound coalesce + turn queue]
  C --> D[conversation.handleIncomingMessage]
  D --> E[buildRuntimePrompt + mode tools]
  E --> F[askClaude]

  F --> G{tool_calls?}
  G -->|lookup| H[search / slots / CRM read]
  H --> F
  G -->|side effects| I[update_client_info / tag / …]
  G -->|terminal| J[order / brief / book / handoff]
  J --> K[Telegram notify]
  G -->|text only| L[gate + instagram.sendText]
```

Inbound: `routes/webhooks.ts` → `lib/inbound-coalesce.ts` → `lib/conversation-turn-queue.ts` → `services/conversation.ts`.

---

## Claude runtime

Customer path goes through `askClaude` → `ClaudeRuntime` (`lib/claude-runtime.ts`). Default is Agent SDK `query()` (`CLAUDE_RUNTIME=sdk`) with coding tools locked down. `CLAUDE_RUNTIME=cli` is a **hotfix rollback** (`claude -p`). Vision turns on the SDK path use an explicit logged CLI fallback (`cli_vision_fallback`). Auth / usage / login stay on `~/.local/bin/claude`. See [`CLAUDE_AGENT_SDK_MIGRATION_PLAN.md`](../CLAUDE_AGENT_SDK_MIGRATION_PLAN.md).

| Piece | Behavior |
|-------|----------|
| Runtime flag | `CLAUDE_RUNTIME=sdk\|cli` (default **`sdk`**; `cli` = hotfix) |
| Customer transport | **sdk:** `@anthropic-ai/claude-agent-sdk` `query()` (lockdown + in-process MCP). **cli hotfix:** `claude -p` JSONL + text `<tool_call>` |
| Binary | `~/.local/bin/claude` (`lib/claude-binary.ts`) — auth/usage always this CLI, even when customer path is `sdk` |
| Args | `-p --output-format stream-json --verbose --model {haiku\|sonnet\|opus}` (CLI path) |
| CWD | `~/.cache/platform-ai-agent/{instance}/claude-spawn` — **isolated** from `~/tenant_knowledge` (avoids parent `CLAUDE.md` pollution) |
| Tools | **SDK (default):** in-process MCP `mcp__platform__*`; lookup handlers run in-process; terminal/`canUseTool` gate, host executes book/collect/handoff in `conversation.ts`. **CLI hotfix:** text `<tool_call>` |
| Concurrency | `CLAUDE_MAX_CONCURRENCY` (default 2) shared IG/sandbox/insights; meta-agent: `CLAUDE_META_MAX_CONCURRENCY` (default 1) — teach does not queue behind IG |
| Warmup | `CLAUDE_WARMUP_ON_START` → `runtime.warmup()` (SDK uses `query()`, not ad-hoc `claude -p`). Bypasses semaphores. Must **not** open the quota circuit |
| Abort | CLI: process-group `SIGKILL` (`detached`) + warn if pid alive after 2s. SDK: `interrupt()` + `query.close()`. Sandbox disconnect / mid-turn prompt activate abort the turn `AbortSignal` |
| Health | Orphan `claude` (ppid 1) → warn only, do not fail the check |
| Session reuse | **One session per turn** (`lib/turn-claude-sessions.ts`): tenant reply model (`sonnet\|opus`) `--resume` across tool rounds. Mid-turn prompt activate clears the resume id **and** aborts in-flight Claude. Lookup rounds reuse `resume`, not a long-lived `ClaudeSDKClient`. SDK has **no `maxTurns` cap** (stop is query timeout). If Claude Code still emits `error_max_turns`, text/tools are kept — not a customer timeout |
| Reply model | Tenant picks **sonnet \| opus**. The same model runs the first spawn and every tool follow-up (no Haiku router). Haiku is not in the admin picker; it is only used for warmup / usage probes. |
| Channels | `instagram`, customer telegram, `meta_agent`, `sandbox`, `supervisor`, `insights` |

---

## Prompt composition (customer agent)

Order in `buildRuntimePrompt` / `askClaude`:

1. Anti-injection preamble  
2. Active system prompt from DB (`system_prompts`, `isActive`) with placeholders (hours, branches, brand)  
3. Session block: time **in tenant timezone** (`agent_config.timezone`, default `Europe/Kyiv` — not the host OS, often DE), client profile, CRM **link hint** (full visits via `get_client_crm_history`), branches, Telegram bots, out-of-hours, previous brief  
4. Live catalog snippet: sales/leadgen → products+services+masters (~12k); **booking** → masters only (≤1k); services/prices via tools  
5. Mode tools block (`formatAgentToolsPrompt`)

| Layer | Injected at runtime? |
|-------|----------------------|
| DB system prompt | Yes |
| Seed `prompts/{sales,leadgen,booking,general}-agent.txt` | First DB seed uses **general** (matches default `agent_config.mode`) |
| Live catalog / services / masters files | Yes (mode-aware snippet) |
| Full CRM visit history | **No** on cold prompt — tool `get_client_crm_history` |
| Legacy `knowledge/contacts|faq|…` | **No** |
| Tenant disk `CLAUDE.md` | **No** (spawn cwd isolated) |
| `<platform_capabilities>` | Meta-agent + **AI-помічник (insights)** — not the customer IG agent |

---

## Agent modes and tools

Shared: `update_client_info`, `tag_client`, `request_handoff`, `create_local_order`; optional `set_conversation_branch`.

| Mode | Purpose | Mode-specific tools | Terminal outcome |
|------|---------|---------------------|------------------|
| **sales** | E-commerce | `search_catalog`, `get_delivery_cost`, `collect_order` | Local order (+ optional CRM mirror) |
| **leadgen** | Qualification / brief | `classify_intent`, `submit_brief` | Brief + Telegram (+ optional KeyCRM lead) |
| **booking** | Salon appointment | `search_services`, `get_available_slots`, `get_client_crm_history`, `attach_reference_photo`, `book_appointment`, `cancel_appointment`, `remove_appointment_service`, `reschedule_appointment` | CRM appointment |
| **general** | All scenarios (**default**) | Union of sales + leadgen + booking (deduped) | Same handlers; pick tool by client intent |

**general** is not a separate tool list: `buildAgentTools('general')` merges the specialized builders. When you add a tool to sales/leadgen/booking, it appears in general automatically (enforced by unit test).

**Cancel / reschedule:** `cancel_appointment` (full visit), `remove_appointment_service` (one line; last line → full cancel), `reschedule_appointment` (cancel old + book new). Do **not** use a second `book_appointment` as a move (SDK denies when an active visit exists on another date/time). **Refund / payment cancel** → still `request_handoff`. BeautyPro supports `PUT` cancel and `services[].action=delete`.

Parallel services at the same clock time need **per-line** `services[].master_id` (different professionals). Slot tool labels `MODE: PARALLEL` vs `MODE: SEQUENTIAL`. A single top-level `master_id` is copied only onto lines that omit their own id; same master → sequential starts in BeautyPro. Preferred master from history applies **only to a similar service**; same display names are disambiguated with positions / short id in slot labels. `book_appointment` refuses `MASTER_SERVICE_MISMATCH` when CRM grades mark the master unavailable for that service. Old failed bookings: admin sets masters per Appointment service line, then retry CRM (`PATCH /orders/:id/booking-services` → `POST /orders/:id/sync-crm`).

**Telegram to managers is not a tool** — it fires as a side effect of handoff / order / brief / booking / cancel / reschedule / agent failure (`services/telegram-notify.ts`).

---

## Multi-CRM

All CRM I/O goes through `getCrmAdapter` + `resolveCrmProvider(action)`. Never call CRM HTTP from `conversation.ts`.

| Provider | Typical actions |
|----------|-----------------|
| KeyCRM | catalog, orders, leads, client upsert |
| CleverBOX | services, branches, booking |
| BeautyPro | services, branches, booking, client upsert, visit history |

Routing modes: `single` | `by_action` | `prompt`. Hybrid example: catalog/order → KeyCRM, services/booking → BeautyPro.

Client link: `Client.crmBuyerId` (+ `crmProvider`, `crmLinkedAt`). Details: `docs/MULTI_CRM_INTEGRATION_GUIDE.md`, BeautyPro: `docs/BEAUTYPRO_CRM_INTEGRATION.md`.

---

## Admin assistants (three different agents)

| UI (nav) | Route | Channel | Role |
|----------|-------|---------|------|
| **AI-помічник** | `/insights` | `insights` | Read-only ops: metrics, dialogs samples, CRM/integration health, **platform capabilities** (modes/tools/CRM), config advice. No writes, no Telegram/CRM mutations. |
| **Навчання агента** | `/teach` | `meta_agent` | Edits system prompt via diffs; gets `<platform_capabilities>`. |
| **Тестування агента** | `/sandbox` | `sandbox` | Simulates customer chat with real tools/prompt. |

Insights context: fresh `buildInsightsSnapshot(period)` + `buildPlatformCapabilitiesBlock()` in `routes/insights.ts`.

---

## What the customer agent can “see”

- Active business prompt (tone, FAQ, rules, offer framing)  
- Client profile fields collected so far + tags + branch  
- Recent conversation (capped ~30 messages)  
- Catalog / services / masters live snippets + search tools  
- CRM link hint when linked (booking); full visits via `get_client_crm_history`  
- Working hours / out-of-hours strategy  
- Mode tool surface only (no inventing tools)

**Must not** expose to the Instagram client: product/offer/CRM UUIDs, internal ids, other conversations’ data.

---

## Performance constraints (current)

| Factor | Impact |
|--------|--------|
| Fresh CLI spawn on **first** round of a turn | Cold start cost (Opus/Sonnet) |
| Tool follow-ups | Same reply model `--resume` (one session per turn) |
| Slot / search tool results | Max **3** slot times/day; service search default limit **8** |
| Semaphore max 2 | Queue / busy fallback under load |
| Large system prompt + catalog + history on cold start | Token and TTFT cost (booking omits services-live dump) |
| Intentional `responseDelay` | Product latency (0–60s), not a bug |
| Insights snapshot | In-memory TTL (~45s) per period — chat turns reuse one snapshot |
| Turn debug | Spawn counters (cold vs resume) in admin agent-turn notes |

Optimization directions (roadmap): parallelize independent tool lookups where safe; compact tool schemas; history char budget.

**Claude Agent SDK migration** (planned, not started): control layer over the same CLI subprocess — typed sessions/events, in-process MCP tools, no Messages API swap and no billing change in that track. Phases + checklists: [`CLAUDE_AGENT_SDK_MIGRATION_PLAN.md`](../CLAUDE_AGENT_SDK_MIGRATION_PLAN.md).

---

## Sync checklist when changing agent surface

1. Update `tool-definitions.ts` + `agent-tools-prompt.ts`  
2. Update `platform-capabilities-prompt.ts`  
3. Update this doc + `apps/workspace/templates/CLAUDE.md` if modes/tools change  
4. Meta-agent and Insights both consume `buildPlatformCapabilitiesBlock()` — one edit covers both
