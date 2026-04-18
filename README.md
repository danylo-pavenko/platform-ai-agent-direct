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
├── /opt/platform-admin/          # Super Admin app (Linux user: platform_admin)
│   └── Port 4000/4001 → https://admin.yourplatform.com
│
└── /opt/agents/
    ├── sb/                       # Client 1 (Linux user: agent_sb)
    │   └── Ports 3100/3101 → api.status-blessed.com + agent.status-blessed.com
    ├── mb/                       # Client 2 (Linux user: agent_mb)
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
│  Admin Panel (Vue 3 + Vuetify)                      │
│  Nginx vhost → client's own domain                  │
└────────────────────────────────────────────────────┘
```

### Isolation model

| Resource | Shared | Per-client |
|----------|--------|------------|
| Codebase | Same repo | — |
| Linux user | — | `agent_{id}` |
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
| Backend | Node.js 20+, TypeScript, Fastify, Prisma 7 (PostgreSQL) |
| Frontend | Vue 3, Vuetify 4, Vite, Pinia, Vue Router |
| Telegram | grammY framework, long polling |
| AI inference | Claude Code headless CLI (`claude -p`), NOT Anthropic API |
| CRM | KeyCRM (pluggable, can be `none`) |
| Process manager | PM2 |
| Reverse proxy | Nginx + Let's Encrypt |

---

## Features

### Core (per-client)
- **Instagram DM automation** — webhook receiver, Claude-powered responses, message splitting for >1000 chars
- **Smart conversation routing** — bot / handoff / paused states, working hours awareness
- **Catalog sync** — periodic KeyCRM fetch, smart filtering
- **Order collection** — Claude collects order details via structured tool calls, sends to TG for manager approval
- **Handoff to humans** — keyword + AI-based escalation, TG notifications with inline actions

### Admin Panel (per-client)
- **Conversations** — full chat history, search, filters, manual reply
- **System Prompts** — versioned prompt management, activate/rollback, diff view
- **Meta-Agent (Teach Chat)** — describe changes in natural language, AI proposes prompt edits
- **Sandbox** — Instagram DM-style test chat, save up to 15 test cases, step-by-step replay
- **Settings** — working hours, handoff keywords, feature flags
- **Orders** — list with status filters, manager actions
- **Sync** — manual trigger, run history, status monitoring

### Super Admin (platform-level)
- **Tenant management** — list all clients, status, provisioning date
- **Deploy control** — trigger deploy per client
- **Health overview** — PM2 status across all instances
- **Metrics** — per-tenant conversation/order counts

---

## Project Structure

```
platform-ai-agent-direct/
├── apps/
│   ├── backend/
│   │   ├── src/
│   │   │   ├── server.ts               # Fastify API (PM2: {ID}-api)
│   │   │   ├── telegram-bot.ts         # grammY bot (PM2: {ID}-bot)
│   │   │   ├── sync-worker.ts          # CRM sync (PM2: {ID}-sync)
│   │   │   ├── config.ts               # Zod-validated env
│   │   │   ├── routes/                 # webhooks, auth, conversations, prompts,
│   │   │   │                           # settings, orders, sync, meta-agent, sandbox
│   │   │   ├── services/               # claude, instagram, conversation, prompt-builder,
│   │   │   │                           # keycrm, order, telegram-notify, media
│   │   │   └── lib/                    # prisma, auth, queue, ig-signature, sanitize
│   │   └── prisma.config.ts
│   ├── admin/                          # Vue 3 SPA (PM2: {ID}-admin)
│   └── workspace/                      # Claude agent context
│       ├── knowledge/                  # brand, contacts, delivery, faq, catalog
│       └── prompts/                    # sales-agent.txt, meta-agent.txt, regression-tests.json
├── infra/
│   ├── nginx/
│   │   └── sb-agent.conf               # Reference nginx config
│   └── scripts/
│       ├── provision-server.sh         # [ROOT] One-time server setup
│       ├── provision-super-admin.sh    # [ROOT] Set up super admin dashboard
│       ├── provision-client.sh         # [ROOT] Onboard new client
│       ├── deploy-client.sh            # [CLIENT USER] Pull + build + restart
│       ├── dev.sh                      # Local development
│       ├── deploy.sh                   # Legacy SB-specific deploy
│       └── provision.sh                # Legacy SB-specific provision
├── ONBOARDING_INSTRUCTION.md           # Step-by-step client onboarding guide
├── ecosystem.config.cjs                # PM2 config (reads INSTANCE_ID from env)
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
SUPER_ADMIN_DOMAIN=admin.yourplatform.com \
CERTBOT_EMAIL=you@example.com \
SUPER_ADMIN_REPO=https://github.com/yourorg/platform-super-admin.git \
bash infra/scripts/provision-super-admin.sh
```

Creates Linux user `platform_admin`, DB `platform_admin`, deploys super admin app.

### Step 3 — Onboard a client

```bash
# DNS A-records for api.status-blessed.com + agent.status-blessed.com → server IP

CERTBOT_EMAIL=you@example.com \
bash infra/scripts/provision-client.sh \
  sb StatusBlessed api.status-blessed.com agent.status-blessed.com 3100 3101
```

### Step 4 — Manual steps per client (after provision)

```bash
su - agent_sb

# 1. Fill in credentials
nano /opt/agents/sb/.env
# Set: META_APP_ID, META_APP_SECRET, IG_PAGE_ACCESS_TOKEN, IG_PAGE_ID
# Set: TELEGRAM_BOT_TOKEN, TELEGRAM_MANAGER_GROUP_ID

# 2. Authenticate Claude Code (one-time, opens browser)
claude auth login

# 3. Deploy
bash /opt/agents/sb/infra/scripts/deploy-client.sh
```

See [ONBOARDING_INSTRUCTION.md](./ONBOARDING_INSTRUCTION.md) for the full step-by-step guide.

---

## Port Allocation

| Instance | API Port | Admin Port | PM2 Prefix |
|----------|----------|-----------|------------|
| Super Admin | 4000 | 4001 | SA- |
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
| `{ID}-admin` | Vue SPA serving |

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
