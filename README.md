# Platform AI Agent Direct

AI Sales Agent for Instagram DM — white-label SaaS platform.

Deploy separate instances per client, each with its own domain, database, Claude Code account, and admin panel.
Managed from a central **Super Admin** dashboard.

**First client:** Status Blessed (Ukrainian streetwear brand)

---

## Architecture

### Server layout

```
server
├── /home/agentsadmin/platform-ai-agent-direct/   # Super Admin app (Linux user: agentsadmin)
│   └── Port 4000 → https://admin.direct-ai-agents.com
│
├── /home/blessed/platform-ai-agent-direct/       # Client 1 (Linux user: blessed)
│   └── Ports 3100/3101 → api.status-blessed.com + agent.status-blessed.com
│
├── /home/mb/platform-ai-agent-direct/            # Client 2 (Linux user: mb)
│   └── Ports 3200/3201 → api.mybrand.com + admin.mybrand.com
└── ...
```

### Per-client stack

```
┌────────────────────────────────────────────────────┐
│              Client Instance (e.g. SB)              │
│                                                     │
│  IG Webhook ─┐                                      │
│  TG Bot ─────┼──→ Conversation Router ──→ Claude    │
│  Admin API ──┘           │               CLI        │
│  Sync Worker ────→ Catalog ──→ PostgreSQL (own DB)  │
│                                                     │
│  Admin Panel (Vue 3 + Vuetify 3)                    │
│  Nginx vhost → client's own domain                  │
└────────────────────────────────────────────────────┘
```

### Isolation model

| Resource | Shared | Per-client |
|----------|--------|------------|
| Codebase | Same repo | — |
| Linux user | — | `{instance_id}` (e.g. `blessed`, `mb`) |
| PostgreSQL DB | Server | Separate DB per client |
| Claude Code account | — | Separate login per user |
| PM2 processes | — | `{ID}-api`, `-bot`, `-sync`, `-admin` |
| NGINX vhost | — | Per domain pair |
| TLS certificates | — | Per domain |
| .env / secrets | — | Per instance |

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Backend | Node.js 20+, TypeScript, Fastify, Prisma 6 (PostgreSQL) |
| Frontend (admin) | Vue 3, Vuetify 3, Vite, Pinia, Vue Router 4 |
| Super Admin | Fastify + vanilla HTML/JS (single-page, no build step) |
| Telegram | grammY framework, long polling |
| AI inference | Claude Code headless CLI (`claude -p`), NOT Anthropic API |
| CRM | KeyCRM (pluggable, can be `none`) |
| Delivery | Nova Poshta API v2 |
| Process manager | PM2 |
| Reverse proxy | Nginx + Let's Encrypt |

---

## Features

### Core (per-client)
- **Instagram DM automation** — webhook receiver, Claude-powered responses, message splitting for >1000 chars
- **Smart conversation routing** — bot / handoff / paused states, working hours awareness
- **Shared post handling** — agent identifies garment type, color, print from IG post; matches CRM catalog; shows size chart
- **Catalog sync** — periodic KeyCRM fetch, smart filtering, `catalog.txt` snapshot for Claude
- **Order collection** — Claude collects order details via structured tool calls, sends to TG for manager approval
- **Delivery cost** — Nova Poshta API v2 integration, `get_delivery_cost` tool for Claude
- **Handoff to humans** — keyword + AI-based escalation, TG notifications with inline actions

### Admin Panel (per-client)
- **Conversations** — full chat history, search, filters, manual reply
- **System Prompts** — versioned prompt management, activate/rollback
- **Meta-Agent (Teach Chat)** — describe changes in natural language, AI proposes prompt edits
- **Sandbox** — Instagram DM-style test chat, save up to 15 test cases, step-by-step replay
- **Settings** — working hours, handoff keywords, integrations (KeyCRM, Nova Poshta), feature flags, runtime mode (Public / Debug)
- **Orders** — list with status filters, manager actions
- **Sync** — manual trigger, run history, status monitoring

### Super Admin (platform-level)
- **Tenant management** — list/add/edit/delete clients, status, domains, ports
- **Deploy control** — trigger deploy per client
- **Health overview** — PM2 status across all instances
- **Test chat** — built-in chat panel to test any client's agent

---

## Runtime mode: Public vs Debug

Each instance has a **runtime mode** that gates how the bot reacts to incoming Instagram DMs. It lives in the `runtime_mode` setting (admin UI: **Settings → Режим роботи бота**) and applies to live webhook traffic.

| Mode | Behavior |
|------|----------|
| **Public** (default) | Bot processes every incoming DM from any IG user. Backfill of older threads is allowed from the same screen. |
| **Debug** | Bot processes DMs **only from whitelisted Instagram handles**. Messages from any other user are dropped at the webhook boundary — no DB write, no Claude call, no reply. Fail-closed: unknown handles are never answered. |

### Debug whitelist format

- Comma or newline separated handles.
- Leading `@` is stripped, everything is lowercased.
- Example: `@test_user, another_handle` → matches `test_user` and `another_handle`.

Use Debug mode on production **after** IG is connected, when you want to test real webhook flow with a known set of accounts before switching to Public.

### Historical backfill

Also on the same card — **"Завантажити останні N розмов"** triggers `POST /settings/meta/import-recent-conversations` with a configurable limit (default 200, max 500). Old threads without bot history have their outgoing messages classified as manager replies, so we can analyse existing support quality from day one.

### Storage shape

```jsonc
// Setting key: runtime_mode
{
  "mode": "public" | "debug",
  "debugWhitelist": ["username1", "username2"],
  "backfillLimit": 200
}
```

The backend caches this setting for 30 s; the cache is invalidated automatically on `PUT /settings`.

---

## Project Structure

```
platform-ai-agent-direct/
├── apps/
│   ├── backend/
│   │   ├── src/
│   │   │   ├── server.ts               # Fastify API (PM2: {ID}-api)
│   │   │   ├── telegram-bot.ts         # grammY bot (PM2: {ID}-bot)
│   │   │   ├── sync-worker.ts          # KeyCRM sync (PM2: {ID}-sync)
│   │   │   ├── config.ts               # Zod-validated env
│   │   │   ├── routes/
│   │   │   │   ├── webhooks.ts         # IG webhook receiver
│   │   │   │   ├── conversations.ts
│   │   │   │   ├── prompts.ts
│   │   │   │   ├── settings.ts         # incl. /nova-poshta/resolve-city
│   │   │   │   ├── orders.ts
│   │   │   │   ├── sync.ts
│   │   │   │   ├── sandbox.ts
│   │   │   │   ├── meta-agent.ts       # Teach Chat
│   │   │   │   ├── meta-oauth.ts       # Facebook OAuth flow
│   │   │   │   ├── dashboard.ts
│   │   │   │   └── admin-auth.ts
│   │   │   ├── services/
│   │   │   │   ├── claude.ts           # headless CLI wrapper
│   │   │   │   ├── conversation.ts     # main message handler
│   │   │   │   ├── prompt-builder.ts   # runtime prompt assembly
│   │   │   │   ├── instagram.ts        # IG Graph API client
│   │   │   │   ├── ig-profile.ts       # profile fetch + cache
│   │   │   │   ├── ig-history.ts       # IG conversation history
│   │   │   │   ├── keycrm.ts           # KeyCRM API client
│   │   │   │   ├── nova-poshta.ts      # NP API v2 delivery cost
│   │   │   │   ├── order.ts            # order builder
│   │   │   │   ├── product-search.ts   # catalog search
│   │   │   │   ├── media.ts            # image download helper
│   │   │   │   └── telegram-notify.ts  # TG notifications
│   │   │   ├── lib/
│   │   │   │   ├── prisma.ts
│   │   │   │   ├── auth.ts
│   │   │   │   ├── queue.ts            # in-memory concurrency queue
│   │   │   │   ├── ig-signature.ts     # HMAC webhook verification
│   │   │   │   ├── sanitize.ts         # input sanitization
│   │   │   │   ├── integration-config.ts # DB-first integration settings
│   │   │   │   ├── tool-definitions.ts # Claude tool schemas
│   │   │   │   └── telegram.ts         # Telegram client helper
│   │   │   ├── prisma/
│   │   │   │   ├── schema.prisma
│   │   │   │   ├── migrations/
│   │   │   │   └── seed.ts
│   │   │   └── generated/prisma/       # generated Prisma client
│   │   ├── prisma.config.ts
│   │   └── tsconfig.json
│   │
│   ├── admin/                          # Vue 3 SPA (PM2: {ID}-admin or static via Vite)
│   │   └── src/views/
│   │       ├── ConversationsView.vue
│   │       ├── ConversationDetail.vue
│   │       ├── PromptsView.vue
│   │       ├── TeachChat.vue
│   │       ├── SandboxView.vue
│   │       ├── SettingsView.vue
│   │       ├── OrdersView.vue
│   │       ├── SyncView.vue
│   │       └── DashboardView.vue
│   │
│   ├── super-admin/                    # Super Admin dashboard
│   │   ├── public/index.html           # Single-page app (Fastify serves it)
│   │   ├── src/
│   │   │   ├── server.ts
│   │   │   ├── routes/tenants.ts
│   │   │   ├── routes/auth.ts
│   │   │   └── config.ts
│   │   └── prisma/schema.prisma        # tenants table
│   │
│   └── workspace/                      # Seed content shared across tenants
│       └── templates/                  # Copied to $HOME/tenant_knowledge on first deploy
│           ├── knowledge/
│           │   ├── brand.txt
│           │   ├── contacts.txt
│           │   ├── delivery.txt
│           │   ├── categories.txt
│           │   └── faq.txt
│           └── prompts/
│               └── sales-agent.txt
│
# Per-tenant runtime (OUTSIDE repo, e.g. /home/blessed/tenant_knowledge/):
#   knowledge/{brand,contacts,delivery,faq,categories,catalog}.txt
#   prompts/sales-agent.txt
│
├── infra/
│   ├── landing/
│   │   ├── index.html                  # Platform landing page
│   │   └── og-image.html               # OG image template
│   ├── nginx/
│   │   ├── platform.conf               # Super Admin nginx config
│   │   └── sb-agent.conf               # Client nginx config reference
│   └── scripts/
│       ├── provision-server.sh         # [ROOT] One-time server setup
│       ├── provision-super-admin.sh    # [ROOT] Set up super admin
│       ├── provision-client.sh         # [ROOT] Onboard new client
│       ├── provision-platform.sh       # [ROOT] Full platform provision
│       ├── deploy-super-admin.sh       # [agentsadmin] Build + restart super admin
│       ├── deploy-client.sh            # [CLIENT USER] Pull + build + restart
│       ├── deploy-landing.sh           # Deploy landing page
│       ├── dev.sh                      # Local development
│       └── provision.sh                # SB-specific provision (legacy)
│
├── ONBOARDING_INSTRUCTION.md           # Step-by-step client onboarding guide
├── ecosystem.config.cjs                # PM2 config for client instances
├── ecosystem.super-admin.config.cjs    # PM2 config for super admin
├── .env.example
└── package.json
```

---

## Quick Start (Local Development)

### Prerequisites

- Node.js 20+
- PostgreSQL 15+
- Claude CLI installed and authenticated (`claude auth login`)

### Setup

```bash
# 1. Clone
git clone https://github.com/danylo-pavenko/platform-ai-agent-direct.git
cd platform-ai-agent-direct

# 2. Install
npm install

# 3. Configure
cp .env.example .env
# Edit .env — minimum: DATABASE_URL, JWT_SECRET

# 4. Create database
createdb sb_agent

# 5. Migrate + seed
cd apps/backend
npx prisma migrate deploy
npx prisma db seed
cd ../..

# 6. Start
bash infra/scripts/dev.sh --all
```

Services start at:
- Backend API: `http://localhost:3100`
- Admin panel: `http://localhost:3101`
- Telegram bot: long polling

Login: credentials from `.env` (`DEFAULT_ADMIN_USERNAME` / `DEFAULT_ADMIN_PASSWORD`).

---

## Production: Deploying the Platform

### Step 1 — One-time server setup

```bash
# On a fresh Ubuntu 22.04+ VPS, run as root:
CERTBOT_EMAIL=you@example.com bash infra/scripts/provision-server.sh
```

Installs: Node.js, PM2, Nginx, Certbot, PostgreSQL, UFW.

### Step 2 — Super Admin dashboard

```bash
bash infra/scripts/provision-super-admin.sh
```

Creates Linux user `agentsadmin`, DB `platform_admin`, deploys super admin on port 4000.

To redeploy after code changes:
```bash
bash infra/scripts/deploy-super-admin.sh
```

### Step 3 — Onboard a client

```bash
# DNS A-records for api.status-blessed.com + agent.status-blessed.com → server IP

CERTBOT_EMAIL=you@example.com \
bash infra/scripts/provision-client.sh \
  blessed Blessed api.status-blessed.com agent.status-blessed.com 3100 3101
```

Script creates Linux user `blessed`, app at `/home/blessed/platform-ai-agent-direct`.

### Step 4 — Manual steps per client (after provision)

```bash
su - blessed

# 1. Fill in credentials
nano ~/platform-ai-agent-direct/.env
# Set: META_APP_ID, META_APP_SECRET, IG_PAGE_ACCESS_TOKEN, IG_PAGE_ID
# Set: TELEGRAM_BOT_TOKEN, TELEGRAM_MANAGER_GROUP_ID

# 2. Authenticate Claude Code (one-time, opens browser)
claude auth login

# 3. Deploy
bash ~/platform-ai-agent-direct/infra/scripts/deploy-client.sh
```

See [ONBOARDING_INSTRUCTION.md](./ONBOARDING_INSTRUCTION.md) for the full step-by-step guide.

---

## Port Allocation

| Instance | API Port | Admin Port | PM2 Prefix |
|----------|----------|-----------|------------|
| Super Admin | 4000 | — | SA- |
| Status Blessed | 3100 | 3101 | SB- |
| Client 2 | 3200 | 3201 | C2- |
| Client 3 | 3300 | 3301 | C3- |

---

## PM2 Process Names

Processes are prefixed with `INSTANCE_ID` (uppercase):

| Process | Description |
|---------|------------|
| `{ID}-api` | Fastify backend |
| `{ID}-bot` | Telegram bot |
| `{ID}-sync` | CRM sync worker |
| `{ID}-admin` | Vue SPA serving (via `vite preview`) |
| `SA-api` | Super Admin (fixed name) |

---

## Environment Variables Reference

See `.env.example` for the full list. Key groups:

| Group | Variables |
|-------|----------|
| Identity | `INSTANCE_ID`, `INSTANCE_NAME`, `BRAND_NAME` |
| Network | `API_PORT`, `ADMIN_PORT`, `ADMIN_DOMAIN`, `API_DOMAIN` |
| Database | `DATABASE_URL` (separate DB per client) |
| Instagram | `META_APP_*`, `IG_*` |
| Telegram | `TELEGRAM_BOT_TOKEN`, `TELEGRAM_MANAGER_GROUP_ID`, `TELEGRAM_ADMIN_PASSWORD` |
| Claude | `CLAUDE_MAX_CONCURRENCY`, `CLAUDE_TIMEOUT_MS`, `CLAUDE_MODEL` |
| Auth | `JWT_SECRET`, `JWT_EXPIRES_IN` |
| CRM | `CRM_PROVIDER`, `KEYCRM_API_KEY` |
| Delivery | `NOVA_POSHTA_API_KEY` (or set via Admin → Settings) |

Super Admin uses a separate `.env.super-admin` file.

---

## Security

- Prompt injection protection: sanitize input, clear user/system separation, output validation
- Cross-conversation isolation: each Claude call gets only its own conversation history
- HMAC SHA256 webhook verification
- JWT auth with role-based access
- Secrets never logged or returned in API responses
- Per-client Linux user isolation (separate process namespace)
- No shared state between tenants

---

## License

Private. All rights reserved.
