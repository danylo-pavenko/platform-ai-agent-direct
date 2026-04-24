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
│   │   │   │   ├── webhooks.ts         # IG webhook + deauthorize callback
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
# Set: FACEBOOK_APP_ID, FACEBOOK_APP_SECRET, IG_WEBHOOK_VERIFY_TOKEN
# Set: ADMIN_DOMAIN, API_DOMAIN (this instance’s public hostnames)
# Set: TELEGRAM_BOT_TOKEN, TELEGRAM_MANAGER_GROUP_ID
# Instagram Page / IG user tokens are obtained via Admin → Settings → Meta (OAuth), not pasted manually.

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
| Instagram / Meta | `FACEBOOK_APP_ID`, `FACEBOOK_APP_SECRET`, `IG_WEBHOOK_VERIFY_TOKEN` (+ tokens in DB after OAuth) |
| Telegram | `TELEGRAM_BOT_TOKEN`, `TELEGRAM_MANAGER_GROUP_ID`, `TELEGRAM_ADMIN_PASSWORD` |
| Claude | `CLAUDE_MAX_CONCURRENCY`, `CLAUDE_TIMEOUT_MS`, `CLAUDE_MODEL` |
| Auth | `JWT_SECRET`, `JWT_EXPIRES_IN` |
| CRM | `CRM_PROVIDER`, `KEYCRM_API_KEY` |
| Delivery | `NOVA_POSHTA_API_KEY` (or set via Admin → Settings) |

Super Admin uses a separate `.env.super-admin` file.

---

## Meta (Facebook) Developer setup & App Review

The backend uses **Facebook Login for Business** (not Instagram Basic Display). OAuth resolves a **Facebook Page** with a connected **Instagram Business** account, stores the **Page access token** and **IG user id** in the database, and subscribes the Page to webhook fields `messages`, `messaging_postbacks`, `messaging_seen`. Graph calls use **v22.0**.

**Marketing / legal URLs (platform):**

- Privacy Policy: [https://direct-ai-agents.com/privacy-policy.html](https://direct-ai-agents.com/privacy-policy.html)
- Terms of Service: [https://direct-ai-agents.com/terms.html](https://direct-ai-agents.com/terms.html)

**Per-client public hostnames** are driven by `.env` on that instance:

| Variable | Example (Status Blessed) | Role |
|----------|--------------------------|------|
| `API_DOMAIN` | `api.status-blessed.com` | OAuth redirect + webhook URL host; must be HTTPS in production |
| `ADMIN_DOMAIN` | `agent.status-blessed.com` | Vue admin origin (CORS) |

Replace with each tenant’s domains (e.g. `api.example.com` / `agent.example.com`). The paths below are always the same.

### URLs derived in code

| Purpose | URL |
|---------|-----|
| OAuth redirect (Facebook Login) | `https://{API_DOMAIN}/settings/meta/oauth-callback` |
| Webhook (Instagram / messaging) | `https://{API_DOMAIN}/webhooks/instagram` |
| Deauthorize callback (App Review required) | `https://{API_DOMAIN}/webhooks/deauthorize` |
| Data deletion request callback (App Review required) | `https://{API_DOMAIN}/webhooks/data-deletion` |
| Data deletion instructions page (platform) | `https://direct-ai-agents.com/data-deletion` |

Local dev: with `API_DOMAIN=localhost`, the redirect uses `http://localhost:{API_PORT}` (see `getApiBaseUrl()` in `apps/backend/src/routes/meta-oauth.ts`).

### One Meta App per tenant vs shared App

In the Meta dashboard, **each app has a single Instagram/Webhook callback URL**. Deployments that use **different** `API_DOMAIN` values therefore need **separate Meta apps** (one per isolated instance), *unless* you intentionally front multiple tenants behind **one** HTTPS API host. You can still add **multiple** entries under **Valid OAuth Redirect URIs** in one app for staging + production, but the **webhook callback** cannot point to two different production API domains at once.

### App Settings → Basic

1. **App ID** / **App Secret** → copy into this instance’s `.env` as `FACEBOOK_APP_ID` and `FACEBOOK_APP_SECRET`.
2. **App icon** — use a square **1024×1024** PNG (upload in Basic settings). A ready-made asset for this product lives at [`docs/branding/meta-app-icon-1024.png`](./docs/branding/meta-app-icon-1024.png).
3. **Privacy Policy URL** / **Terms of Service URL** — use the platform links above (or the tenant’s own if you rebrand legally).
4. **App domains** — typically your public web presence (e.g. `direct-ai-agents.com` and/or the tenant admin domain without `https://`). Follow Meta’s current validator hints if submission fails.
5. **Add platform → Website** — set **Site URL** to this deployment’s public site. For an API-first instance, using the API origin is acceptable if that matches what you expose to Meta (example: `https://api.status-blessed.com`).

### Facebook Login for Business → Settings

Under **Valid OAuth Redirect URIs**, add one URI **per API host** this codebase uses (the host must match `API_DOMAIN` in `.env`):

```text
https://api.status-blessed.com/settings/meta/oauth-callback
```

For each new isolated deployment:

```text
https://{that-client-API_DOMAIN}/settings/meta/oauth-callback
```

The admin UI is served from `ADMIN_DOMAIN`; OAuth still redirects to the **API** origin above.

### Instagram / Messenger products & Webhooks

1. Subscribe to **Instagram** (and/or **Messenger** as required by your use case) per Meta’s product checklist.
2. **Callback URL:** `https://{API_DOMAIN}/webhooks/instagram`
3. **Verify token:** must exactly match `IG_WEBHOOK_VERIFY_TOKEN` in `.env` (same value you enter in the Meta webhook UI).
4. Webhook **POST** bodies are verified with **HMAC SHA256** using `FACEBOOK_APP_SECRET`.

Ensure the **Facebook Page** is linked to an **Instagram Business** profile in Business Manager (**Accounts → Instagram accounts**).

### Permissions requested in code (App Review)

These scopes are requested in [`apps/backend/src/routes/meta-oauth.ts`](./apps/backend/src/routes/meta-oauth.ts) — keep the dashboard **App Review** list in sync:

| Permission | Purpose |
|------------|---------|
| `business_management` | Access business assets / accounts for Page–IG linking |
| `pages_show_list` | List Pages the user manages (pick Page with IG) |
| `pages_read_engagement` | Read Page content / engagement where needed |
| `pages_messaging` | Page messaging (used with IG DM / subscribed webhook fields) |
| `instagram_basic` | Basic Instagram profile metadata |
| `instagram_manage_messages` | Send/receive Instagram Direct as the connected account |
| `instagram_business_basic` | Business account basics |
| `instagram_business_manage_messages` | Business IG message management |

Your App Review submission should describe **one concrete use case** (e.g. customer support / sales automation in Instagram DM), with screen recordings from **Admin → Settings → Meta** and a live test user if Meta asks.

### Quick copy-paste checklist (per client)

1. `developers.facebook.com/apps` → your **client’s** App → **App Settings → Basic** → copy **App ID** / **App Secret** into `.env`.
2. **App Settings → Basic → Add Platform → Website** → Site URL `https://{API_DOMAIN}` (or your chosen public URL).
3. **App Settings → Basic → Privacy Policy URL** → `https://direct-ai-agents.com/privacy-policy` · **Terms of Service URL** → `https://direct-ai-agents.com/terms`.
4. **App Settings → Basic → Deauthorize Callback URL** → `https://{API_DOMAIN}/webhooks/deauthorize`.
5. **App Settings → Basic → Data Deletion** → select **"Data Deletion Request URL"** → `https://{API_DOMAIN}/webhooks/data-deletion` (callback). Alternatively use **"Data deletion instructions URL"** → `https://direct-ai-agents.com/data-deletion` (static page). Callback preferred for App Review.
6. **Facebook Login for Business → Settings** → **Valid OAuth Redirect URIs** → `https://{API_DOMAIN}/settings/meta/oauth-callback`.
7. **Instagram** (Webhooks) → **Callback URL** `https://{API_DOMAIN}/webhooks/instagram`, **Verify token** = `IG_WEBHOOK_VERIFY_TOKEN`.
8. On the server: set `ADMIN_DOMAIN`, `API_DOMAIN`, `FACEBOOK_APP_ID`, `FACEBOOK_APP_SECRET`, `IG_WEBHOOK_VERIFY_TOKEN`, deploy, then complete **Meta** connection in the admin UI.

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
