# Claude Agent SDK — план міграції runtime

**Контекст (історичний).** До міграції customer / admin агенти викликали Claude через
headless CLI: `askClaude()` → `spawn(claude -p)`. Tools — текстовий `<tool_call>`.
**Зараз (Phase 5):** default `CLAUDE_RUNTIME=sdk` (`query()` + in-process MCP);
`cli` лишається hotfix. Dual sessions (Sonnet/Opus reply + Haiku router) через
`--resume`. Auth — `claude auth login` per Linux user (Max/Pro).

**Мета документа:** зафіксувати, *чому* переходимо на Claude Agent SDK, які
інваріанти не ламаємо, і покроковий план імплементації з чеклістами — без
підміни salon/sales агента на coding-daemon і без обов’язкової зміни billing.

**Джерела:**
- Поточний runtime: `docs/AGENT_RUNTIME.md`, `apps/backend/src/services/claude.ts`, `conversation.ts`
- SDK (TS): `@anthropic-ai/claude-agent-sdk` — [Agent SDK docs](https://code.claude.com/docs/en/agent-sdk/typescript)
- Hosting / isolation: [Hosting the Agent SDK](https://code.claude.com/docs/en/agent-sdk/hosting)
- Custom tools: in-process MCP (`createSdkMcpServer` / `tool()`)

---

## Статус реалізації (станом на 2026-08-21)

**Phase 0 — runtime contract: ✅ DONE**
**Phase 1 — SDK transport: ✅ DONE** (staging 20 sandbox dialogs — ops)
**Phase 2 — lookup tools as in-process MCP: ✅ DONE** (staging native-vs-text metric — ops)
**Phase 3 — terminal tools + canUseTool: ✅ DONE** (sandbox/staging scenarios — ops)

- Types + fallbacks: `lib/claude-runtime.ts`
- Finalize (text tools + sanitize): `lib/claude-finalize-response.ts` (SDK skips text-protocol parse)
- CLI implementation: `services/claude-cli-runtime.ts`
- SDK `query()`: `services/claude-sdk-runtime.ts` + lockdown `lib/claude-sdk-options.ts`
- Lookup MCP: `services/claude-sdk-lookup-mcp.ts` + `services/agent-lookup-tools.ts`
- Terminal gate: `lib/claude-sdk-permissions.ts` (`canUseTool`)
- Factory: `services/claude-runtime-factory.ts`
- Facade: `askClaude` / `askClaudeStream` + `setClaudeRuntimeForTest`
- Env: `CLAUDE_RUNTIME=cli|sdk` (default **`sdk`**; `cli` = hotfix)
- Package: `@anthropic-ai/claude-agent-sdk` in `apps/backend`
- Phase 4: `runtime.warmup()`, process-group kill + 2s alive log, orphan warn, turn `AbortSignal`

**Phase 4 — process lifecycle: ✅ DONE** (load: 5 sequential booking turns / 2 parallel session isolation — ops)

**Phase 5 — default SDK, remove CLI glue: ✅ DONE** (cli hotfix kept; delete `cli` runtime after 2 prod tenants ≥ 1 week — ops)

Staging / existing `.env` with `CLAUDE_RUNTIME=cli` stay on CLI until ops flips the flag. New tenants + empty env use SDK.

---

## Формулювання (source of truth)

> **Claude Agent SDK — не Messages API і не усуває Claude Code process.** За
> замовчуванням SDK запускає bundled Claude Code CLI як subprocess і спілкується
> з ним через streaming/control protocol. SDK прибирає необхідність керувати цим
> subprocess вручну й дає typed API для sessions, events, permissions, hooks,
> interrupts і tools. Особливо важлива перевага — власні tools як in-process MCP
> у нашому Node process. Billing/auth залежить від способу авторизації й **не** є
> головною архітектурною відмінністю цього плану.

Process boundary лишається:

```text
conversation.ts (власник бізнес-loop)
        │
        ▼
ClaudeRuntime adapter
        │
 ClaudeSDKClient (reply)     ClaudeSDKClient (router / haiku)
        │                              │
        ▼                              ▼
 bundled Claude Code subprocess × N (semaphore)
        │
        ▼  native tool_use
 in-process MCP (наш Node process)
        │
        ▼
 існуючі handlers → CrmAdapter / Prisma
```

**Не плутати з Messages API.** Прямий HTTP до Anthropic — інший трек (прибрав би
spawn, зламав би поточний Max subscription path). У цьому плані його немає.

**Не плутати з coding-агентом.** `Read` / `Edit` / `Bash` / filesystem у customer
path **заборонені**. Наш еквівалент «вузькі capabilities замість curl» — CRM/catalog
tools, не Git/Jira.

---

## Мета

1. **Control layer замість ручного spawn.** Typed events, session id, interrupt,
   permissions, hooks — замість самописного JSONL у `claude-stream-parse.ts`.
2. **Native tools.** Lookup (а згодом terminal) через in-process MCP, не regex по
   `<tool_call>`.
3. **Той самий бізнес-loop.** `conversation.ts` лишається оркестратором turn
   (CRM, Telegram, terminal invariants, mid-turn prompt activate, dual sessions).
4. **Той самий auth.** `claude auth login` per Linux user, quota gate, usage
   monitor — без міграції на API key у цьому плані.
5. **Безпечний rollout.** Flag `CLAUDE_RUNTIME=cli|sdk`, dual-run, rollback без
   міграції БД.

---

## Принципи (не порушувати)

1. **Один власник loop.** SDK не стає автономним агентом з `maxTurns: 20+`.
2. **Tools спочатку lookup, потім terminal.** `book_appointment` / `collect_order`
   / `request_handoff` не віддаємо у вільний SDK loop, поки немає `canUseTool` і
   тих самих інваріантів, що в `tryTerminalToolCalls`.
3. **CRM лише через adapter.** MCP handlers не роблять HTTP. `getCrmAdapter` +
   `resolveCrmProvider(action)`.
4. **Публічний фасад стабільний у Phase 0–1.** `askClaude` / `askClaudeStream`
   лишаються entrypoint для `conversation.ts`, sandbox, teach, insights,
   follow-up, supervisor.
5. **Telegram notify — side effect нашого коду, не tool для моделі.**
6. **Не тримати SDK client між IG-повідомленнями.** Історія в Postgres; isolation
   ~30 msgs; mid-turn prompt activate має `close()` + clear sessions.

---

## Архітектурні рішення

### R1. Адаптер, не «замінити claude.ts викликами SDK скрізь»

Типи `ClaudeRequest` / `ClaudeResponse` / `ClaudeCallContext` / `ToolDefinition`
живуть у `lib/claude-runtime.ts` (зараз частина з них сидить у `services/claude.ts`
і їх тягнуть `tool-definitions.ts`, `agent-tools-prompt.ts`).

```ts
export interface ClaudeRuntime {
  complete(req: ClaudeRequest, ctx?: ClaudeCallContext): Promise<ClaudeResponse>;
  stream(
    req: ClaudeRequest,
    ctx: ClaudeCallContext | undefined,
    onDelta: (delta: string) => void,
    signal?: AbortSignal,
  ): Promise<ClaudeResponse>;
}
```

`askClaude` / `askClaudeStream` — фасади: semaphore, quota-gate, `recordInvocation`,
fallback busy/timeout, потім `runtime.complete|stream`.

Env: `CLAUDE_RUNTIME=cli|sdk` (default **`sdk`**; `cli` hotfix).

### R2. Жорсткий lockdown coding tools

Кожен SDK `query()` / `ClaudeSDKClient`:

| Option | Значення |
|--------|----------|
| `cwd` | `resolveClaudeSpawnCwd()` (як зараз) |
| `settingSources` | `[]` — tenant `CLAUDE.md` не є customer prompt |
| `systemPrompt` | runtime prompt з DB + injections (заміна default coding prompt) |
| `allowedTools` | Phase 1: `[]`; далі лише наші MCP |
| `disallowedTools` | `Bash`, `Read`, `Write`, `Edit`, `Glob`, `Grep`, `WebSearch`, `WebFetch` |
| `permissionMode` | `dontAsk` |
| `maxTurns` | `1` поки loop у `conversation.ts`; lookup-only експеримент 2–3 — окремо |
| `includePartialMessages` | `true` для stream (teach) |
| `resume` | `req.resumeSessionId` |
| env | `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`; credentials як у процесі tenant |

Тест-снапшот options обов’язковий (регрес «раптом з’явився Bash»).

### R3. Dual sessions лишаються

`lib/turn-claude-sessions.ts` без зміни контракту: окремі resume id для `reply`
і `router`. На SDK path це два короткі client/query lifecycle на turn, не дві
вічні сесії. Phase 4 може тримати client **відкритим між раундами того ж turn**.

### R4. Класи tools

| Клас | Tools | Коли в SDK |
|------|--------|------------|
| **Lookup (readonly)** | `search_catalog`, `search_services`, `get_available_slots`, `get_delivery_cost`, `get_client_crm_history` | Phase 2 MCP, `readOnlyHint: true` |
| **Profile side-effect** | `update_client_info`, `tag_client`, `set_conversation_branch`, `attach_reference_photo` | Phase 2 можна MCP з тим самим handler, що `runSideEffectToolCalls` |
| **Terminal** | `book_appointment`, `collect_order`, `create_local_order`, `submit_brief`, `request_handoff` | Phase 3 MCP + `canUseTool`; доти — `conversation.ts` після відповіді |

Allowlist per mode (`sales` / `leadgen` / `booking`) = `tool-definitions.ts`.
Meta-agent / insights **не** отримують booking/order MCP.

Інваріанти terminal (перенести в `canUseTool` у Phase 3):

- Немає клієнтського «записала / замовлення оформлено» без успішного handler.
- Немає другого `book_appointment` як reschedule (інша дата = новий візит →
  deny + `request_handoff`).
- Немає `force=true` на BeautyPro `409 TIME_CONFLICT`.
- Cancel / move / refund → лише `request_handoff`.

### R5. Auth / billing — поза скоупом міграції

Лишаємо: Settings → Claude OAuth, `claude-auth.ts`, `claude-usage.ts`, quota gate.
SDK subprocess успадковує той самий `~/.claude` Linux user.

API key / pay-as-you-go — **окреме ops-рішення**, не blocker Phase 0–5. Якщо в
`.env` з’явиться `ANTHROPIC_API_KEY`, він переможе Max — не додавати «для експерименту».

Usage CLI (`~/.local/bin/claude auth|usage`) можна лишити навіть коли агент іде
через bundled SDK binary.

### R6. 1 session = 1 CLI process

`CLAUDE_MAX_CONCURRENCY` (default 2) + `CLAUDE_META_MAX_CONCURRENCY` (default 1)
залишаються. SDK не робить Claude «легким HTTP client». Phase 4: interrupt,
process-group kill, reap orphans (відомий клас багів SDK close/MCP grandchildren).

Не тримати persistent client між діалогами. Не шарити cwd/session files між
паралельними turns.

---

## Карта файлів

| Файл / зона | Phase 0 | 1 | 2 | 3 | 4 | 5 |
|-------------|---------|---|---|---|---|---|
| `lib/claude-runtime.ts` (новий) | створити | — | — | — | — | — |
| `services/claude.ts` | фасад | тонший | — | — | warmup | прибрати spawn path |
| `services/claude-sdk-runtime.ts` (новий) | stub | `query()` | MCP lookup | permissions | client lifecycle | default |
| `config.ts` | `CLAUDE_RUNTIME` | — | — | — | — | default `sdk` |
| `conversation.ts` | ні | ні | спростити search/slots | terminal через MCP | close on activate | — |
| `lib/tool-definitions.ts` | типи з runtime | ні | shared zod → MCP | — | — | — |
| `lib/agent-tools-prompt.ts` | ні | ні | lookup rules в tool description | видалити customer text protocol | — | — |
| `lib/parse-tool-calls.ts` | ні | гібрид native+text | гібрид | dead-code / прибрати з customer path | — | — |
| `lib/claude-stream-parse.ts` | ні | лише `cli` path | — | — | — | вузький / видалити |
| `lib/turn-claude-sessions.ts` | ні | ні | ні | ні | close clients | — |
| `lib/platform-capabilities-prompt.ts` | ні | опційно | так | так | — | так |
| `docs/AGENT_RUNTIME.md` + template `CLAUDE.md` | 1 абзац | так | так | так | так | так |
| `claude-auth.ts` / `claude-usage.ts` / quota | ні | ні | ні | ні | health orphan warn | auth CLI лишається |
| `infra/scripts/setup-claude-cli.sh` | ні | ні | ні | ні | ні | агент ≠ цей binary |

Виклики `askClaude` (не розмазувати SDK по них): `conversation.ts`, `sandbox.ts`,
`meta-agent.ts`, `meta-agent-teach.ts`, `insights.ts`, `follow-up.ts`,
`supervisor.ts`, `meta-agent-test.ts`.

---

## Phase 0 — Runtime contract

**Мета:** підключити другий runtime, не змінюючи поведінку.  
**Ризик:** низький. **БД:** немає.

### Зробити

- [x] Винести `ClaudeRequest`, `ClaudeResponse`, `ClaudeCallContext`, `ToolDefinition` у `lib/claude-runtime.ts`
- [x] Інтерфейс `ClaudeRuntime` + `createClaudeRuntime()` (`cli` = поточний spawn)
- [x] `sdk` stub: явна помилка «not implemented», не тихий fallback на cli
- [x] `CLAUDE_RUNTIME` у `config.ts` + `.env.example` (default `cli`)
- [x] `askClaude` / `askClaudeStream` — фасади (semaphore, quota, record, fallback)
- [x] Контракт-тести: busy/timeout fallback, `sessionId`+`resumed`, merge text-tools, sanitization, quota **перед** викликом, admin vs customer fallback
- [x] Абзац у `docs/AGENT_RUNTIME.md`: runtime = CLI, SDK planned

### Вихід

Merge в main дозволений. Поведінка байт-в-байт як зараз. Немає обов’язкової
залежності від `@anthropic-ai/claude-agent-sdk` (або пакет є, але мертвий за flag).

---

## Phase 1 — SDK як transport (tools не чіпати)

**Мета:** на `CLAUDE_RUNTIME=sdk` прибрати ручний spawn + JSONL parse. Text
`<tool_call>` ще живий.  
**Ризик:** середній (events, resume, vision, timeout).

### Зробити

- [x] Додати `@anthropic-ai/claude-agent-sdk` у `apps/backend`
- [x] `services/claude-sdk-runtime.ts`: `query()` + map messages → `ClaudeResponse`
- [x] Options lockdown (R2) + тест-снапшот `allowedTools` / `disallowedTools`
- [x] `resume` = `req.resumeSessionId`; resume fail → один cold retry (як зараз)
- [x] Rate-limit / unusable text → `fallback: 'timeout'` + `noteClaudeRateLimit`
- [x] Stream deltas для `/teach`
- [x] Timeout / `AbortSignal` → SDK abort + `query.close()` watchdog
- [x] Vision: явний `runtime=cli_vision_fallback` з логом (не мовчазний degrade)
- [x] Dual sessions на SDK path (той самий facade `resumeSessionId`)
- [x] `getClaudeBinaryPath()` для auth/usage не чіпати (два бінарники тимчасово ок)
- [ ] Staging: 20 sandbox діалогів (sales / leadgen / booking) без зростання fallback rate

### Не робити в Phase 1

MCP tools. Зміни гілок tools у `conversation.ts`. Видалення `parse-tool-calls.ts`.

### Вихід

Один внутрішній / staging tenant може їхати на `sdk`. Решта — `cli`. Rollback:
`CLAUDE_RUNTIME=cli` + PM2 restart, без міграції БД.

---

## Phase 2 — Lookup tools як in-process MCP

**Мета:** search / slots / history / delivery — native `tool_use`.  
**Ризик:** середній (промпт, паралельні CRM виклики).

### Зробити

- [x] `createSdkMcpServer` з lookup tools; handlers = існуюча логіка з `conversation.ts`, не копія HTTP
- [x] Shared schemas: Zod (узгоджено з `tool-definitions.ts`) — один source of truth
- [x] Allowlist per `agent_mode`; `get_client_crm_history` лише booking + linked client
- [x] `readOnlyHint: true`; обмежити паралелізм (`MAX_LOOKUP_CONCURRENCY = 2`)
- [x] Правила «не кажи клієнту що шукаєш без tool» — у `description` + prompt; lookup-імена прибрані з JSON text protocol на SDK path
- [x] `finalizeResponse` гібрид: native `tool_use` + text `<tool_call>` (вже Phase 1; prefix `mcp__platform__` знімається)
- [x] Інваріант: порожній `search_services` → не вигадувати ціну; BeautyPro UUID не світити клієнту
- [x] Оновити `platform-capabilities-prompt.ts`, `docs/AGENT_RUNTIME.md`, template `CLAUDE.md`
- [x] Unit-тести MCP allowlist + lookup handlers (mock adapter)
- [ ] Staging: native tool calls > 90% vs text-parser

`maxTurns` default лишається 1 (повертаємось у `conversation.ts`). Експеримент
search→slots в одному `query()` (`maxTurns: 2–3` лише readonly) — окремий flag,
не default.

### Вихід

Lookup надійніший. `conversation.ts` ще оркеструє terminal; search/slots гілки
можна спростити.

---

## Phase 3 — Terminal tools через permissions, викинути text protocol

**Мета:** модель більше не малює JSON у прозі. Side effects — `canUseTool` + MCP.  
**Ризик:** високий (CRM write, Telegram, гроші).

### Зробити

- [x] MCP для terminal tools (схеми + HOST_QUEUED; мутації виконує `conversation.ts`)
- [x] `canUseTool`: повні args для book/collect; deny reschedule-через-book; `request_handoff` always allow; deny `force=true`
- [x] Handlers lookup = `executeLookupTool`; terminal host = `tryTerminalToolCalls` / `handleSubmitBrief` (без дубля CRM write)
- [x] Після terminal: `mutationsAllowed: false` прибирає book/collect з MCP allowlist; `maxTurns: 1`
- [x] `submit_brief` досі віддає closing text клієнту (host path)
- [x] Meta-agent / insights — без tools → без booking/order MCP
- [x] SDK customer path не парсить `<tool_call>` (CLI path лишає text protocol до Phase 5)
- [ ] Sandbox + staging: sales `collect_order`, booking confirm, leadgen brief, handoff, cancel→handoff
- [x] Follow-up / supervisor / sandbox на тому ж runtime (follow-up без booking MCP)

### Вихід

Text protocol мертвий на customer path. Rollback усе ще `CLAUDE_RUNTIME=cli`
(cli path до Phase 5 тримає text tools).

**Стоп-критерій (обов’язковий відкат):** 1 інцидент «запис у CRM / “записала”
клієнту без успішного handler».

---

## Phase 4 — Lifecycle процесу

**Мета:** закрити наслідок «1 session = 1 CLI process».  
**Ризик:** середній (витоки процесів).

### Зробити

- [x] `CLAUDE_WARMUP_ON_START` → `runtime.warmup()` (не окремий ad-hoc `claude -p`, якщо sdk)
- [x] У межах одного turn lookup-раунди через `resume` (окремі reply/router ids); після abort — `interrupt`+`close` / process-group kill. Не тримаємо `ClaudeSDKClient` між IG messages
- [x] Mid-turn prompt activate: `sessions.clearAll()` **і** abort in-flight (`AbortSignal`)
- [x] Abort/timeout: interrupt + kill process group; лог якщо pid живий через 2s
- [x] Health-check: warn на orphan `claude` процеси (не падати)
- [ ] Навантаження: 5 послідовних booking turns — RSS/процеси до baseline; 2 паралельні turns не шарять session files *(ops)*
- [x] Abort sandbox stream не лишає `claude` в `ps` (disconnect → turn AbortSignal + group kill)
- [x] Warmup не відкриває quota circuit; meta semaphore не стоїть за IG

### Вихід

SDK path стабільний при `CLAUDE_MAX_CONCURRENCY=2`, без zombie CLI.

---

## Phase 5 — Default SDK, прибрати CLI glue

**Мета:** один агентний runtime. Auth CLI може лишитись.  
**Ризик:** низький, якщо Phase 1–4 зелені на 2+ tenants.

### Зробити

- [x] Default `CLAUDE_RUNTIME=sdk`
- [x] Flag `cli` живий ще 1 реліз (hotfix)
- [x] Customer complete path за замовчуванням — `query()`, не `spawnClaude` / `buildClaudeCliArgs` (`parseClaudeStreamJson` лишається для cli hotfix)
- [x] Немає `child_process.spawn` у default customer complete path (vision `cli_vision_fallback` і `CLAUDE_RUNTIME=cli` — винятки)
- [x] Docs: `AGENT_RUNTIME.md`, `.cursor/rules/agent-runtime.mdc`, template `CLAUDE.md`, `ONBOARDING_INSTRUCTION.md` — CLI для **auth/usage**, SDK для відповідей
- [x] `platform-capabilities-prompt.ts` синхронний з native tools
- [ ] Два прод-tenants ≥ 1 тиждень на sdk без зростання fallback rate *(ops)*
- [ ] Потім видалити `cli` runtime *(після ops-гейту)*

### Вихід

Агент = Agent SDK. Onboarding більше не вимагає `~/.local/bin/claude` *для відповідей*
(бінарник для Settings login/usage — ок).

---

## Порядок увімкнення на tenants

```text
local sandbox
  → staging tenant (sdk + text tools)                          # після Phase 1
  → staging (sdk + MCP lookup)                                 # після Phase 2
  → 1 friendly prod (sdk + MCP lookup, terminal ще conversation.ts)
  → prod Phase 3 (permissions / terminal MCP)
  → default sdk, cli як rollback ≥ 1 тиждень                   # Phase 5
```

### Стоп / rollback

Будь-яка умова → `CLAUDE_RUNTIME=cli` + restart, без міграції:

- fallback rate **+20%** vs baseline того ж tenant
- 1 інцидент CRM write / підтвердження клієнту без handler
- zombie `claude` після abort, що не прибирається watchdog

---

## Не робимо в цьому плані

- Anthropic Messages API як заміна spawn.
- Перехід billing на `ANTHROPIC_API_KEY` / pay-as-you-go.
- `Bash` / `Read` / `Write` / `Edit` у customer або admin assistants «бо SDK вміє».
- Віддати весь turn в `maxTurns: 20` (втрата Haiku/Sonnet split, Telegram timing,
  anti-reschedule).
- HTTP CRM у MCP handler напряму.
- Persistent SDK client між діалогами / між tenants.
- Зміна Linux-user isolation, PM2 layout, `CrmAdapter` контракту.
- Agent cancel / reschedule / refund tools (як і раніше → `request_handoff`).

---

## Тест-план (регресія на кожній фазі з 1+)

| Сценарій | Канал | Очікування |
|----------|--------|------------|
| Простий FAQ без tools | sandbox + IG | українська відповідь, без `<tool_call>` у клієнта |
| Booking: послуга → слоти → confirm | sandbox + staging IG | `search_services` + `get_available_slots` + `book_appointment`; UUID не в тексті |
| Booking: «скасуйте запис» | sandbox | `request_handoff`, без другого book |
| Sales: confirm замовлення | sandbox | `collect_order` + Telegram side effect |
| Leadgen: бриф | sandbox | `submit_brief` + closing text клієнту |
| Dual session | turn debug | 1+ resume reply; router haiku на follow-up |
| Rate limit / quota | mock / gate | customer fallback, не сирий JSON |
| Teach stream abort | admin | process не zombie |
| Meta-agent vs IG | concurrency | meta не голодує і не блокує customer semaphore |
| Insights | admin | без booking MCP, без CRM write |
| Vision (якщо є фото) | sandbox | SDK ok або явний cli fallback |

Після Phase 2 додатково: частка native vs text tool calls (ціль > 90% native).

---

## Sync checklist (коли змінюється agent surface у фазах 2–5)

Як у `docs/AGENT_RUNTIME.md`:

1. `tool-definitions.ts` (+ MCP schemas, не роз’їжджатись)
2. `agent-tools-prompt.ts` (або його наступник — tool `description`)
3. `platform-capabilities-prompt.ts`
4. Цей план (статус фази) + `docs/AGENT_RUNTIME.md` + `apps/workspace/templates/CLAUDE.md`
5. `.cursor/rules/agent-runtime.mdc` — коли default стане SDK (Phase 5)

---

## Наступна реалізація

План коду (Phase 0–5) закритий, окрім ops-гейтів:

- Два прод-tenants ≥ 1 тиждень на `sdk` без зростання fallback rate
- Після цього — видалити `cli` runtime і `spawnClaude` з customer hotfix path

Не включати: Messages API, зміну auth/quota, `maxTurns: 20`.
Rollback: `CLAUDE_RUNTIME=cli` + PM2 restart.
)
