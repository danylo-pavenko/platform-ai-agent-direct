# Platform AI Agent Direct

AI Sales Agent for Instagram DM with admin dashboard, Telegram manager bot, and CRM integration.
Built as a white-label platform — deploy a separate instance for each brand with its own prompts, knowledge base, and CRM.

**First client:** Status Blessed (Ukrainian streetwear brand)

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                     VPS / Server                         │
│                                                          │
│  ┌──────────────────────────────────────────────────┐    │
│  │              Backend (Fastify + TS)               │    │
│  │                                                   │    │
│  │  IG Webhook ─┐                                    │    │
│  │  TG Bot ─────┼──→ Conversation Router ──→ Claude  │    │
│  │  Admin API ──┘           │                  CLI   │    │
│  │  Sync Worker ────→ Catalog ──→ PostgreSQL         │    │
│  └──────────────────────────────────────────────────┘    │
│                                                          │
│  ┌──────────────────────────────────────────────────┐    │
│  │         Admin Panel (Vue 3 + Vuetify)             │    │
│  └──────────────────────────────────────────────────┘    │
│                                                          │
│  Nginx (TLS) ──→ Routes to backend + frontend            │
└─────────────────────────────────────────────────────────┘
       ▲              ▲              ▲           ▲
  Instagram      Telegram        KeyCRM      Claude
  Graph API      Bot API          API       CLI (headless)
```

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Backend | Node.js 20+, TypeScript, Fastify, Prisma 7 (PostgreSQL) |
| Frontend | Vue 3, Vuetify 4, Vite, Pinia, Vue Router |
| Telegram | grammY framework, long polling |
| AI inference | Claude Code headless CLI (`claude -p`), NOT Anthropic API |
| CRM | KeyCRM (pluggable, can be replaced) |
| Process manager | PM2 |
| Reverse proxy | Nginx + Let's Encrypt |

## Features

### Core
- **Instagram DM automation** — webhook receiver, Claude-powered responses, message splitting for >1000 chars
- **Smart conversation routing** — bot / handoff / paused states, working hours awareness
- **Catalog sync** — periodic KeyCRM fetch, smart filtering (stock validation, service items handling, OOS alternatives)
- **Order collection** — Claude collects order details via structured tool calls, sends to TG for manager approval
- **Handoff to humans** — keyword + AI-based escalation, TG notifications with inline actions

### Admin Panel
- **Conversations** — full chat history, search, filters by state, manual reply
- **System Prompts** — versioned prompt management, activate/rollback, diff view
- **Meta-Agent (Teach Chat)** — describe changes in natural language, AI proposes prompt edits
- **Sandbox** — Instagram DM-style test chat, save up to 15 test cases, step-by-step replay with confirmation, live prompt editing
- **Settings** — working hours (with 24/7 mode), out-of-hours behavior, handoff keywords, feature flags
- **Orders** — list with status filters, manager actions
- **Sync** — manual trigger, run history, status monitoring

### Telegram Bot
- `/start` — welcome + interactive menu
- `/login` — password auth, links TG user to admin account
- `/help` — full command reference
- Inline keyboards — active conversations, sync trigger, takeover/return/approve/decline

### Security
- Prompt injection protection (3 levels: sanitize, prompt structure, output validation)
- Cross-conversation isolation — each Claude call gets only its own conversation
- HMAC SHA256 webhook verification
- JWT auth with role-based access
- No internal IDs/prices exposed to clients

## Project Structure

```
platform-ai-agent-direct/
├── apps/
│   ├── backend/
│   │   ├── src/
│   │   │   ├── server.ts           # Fastify API (PM2: SB-api)
│   │   │   ├── telegram-bot.ts     # grammY bot (PM2: SB-bot)
│   │   │   ├── sync-worker.ts      # KeyCRM sync (PM2: SB-sync)
│   │   │   ├── config.ts           # Zod-validated env config
│   │   │   ├── routes/             # webhooks, auth, conversations, prompts,
│   │   │   │                       # settings, orders, sync, meta-agent, sandbox
│   │   │   ├── services/           # claude, instagram, conversation, prompt-builder,
│   │   │   │                       # keycrm, order, telegram-notify, media
│   │   │   ├── lib/                # prisma, auth, queue, ig-signature, sanitize,
│   │   │   │                       # telegram, tool-definitions
│   │   │   └── prisma/             # schema, migrations, seed
│   │   └── prisma.config.ts
│   ├── admin/                      # Vue 3 SPA (PM2: SB-admin)
│   │   └── src/views/              # Login, Conversations, ConversationDetail,
│   │                               # Prompts, Settings, Orders, Sync,
│   │                               # TeachChat, Sandbox
│   └── workspace/                  # Claude agent context
│       ├── knowledge/              # brand, contacts, delivery, faq, catalog
│       └── prompts/                # sales-agent.txt, regression-tests.json
├── infra/
│   ├── nginx/sb-agent.conf
│   └── scripts/
│       ├── dev.sh                  # Local development
│       ├── deploy.sh               # Production deployment
│       └── provision.sh            # Server provisioning
├── ecosystem.config.cjs            # PM2 configuration
├── .env.example
└── package.json                    # npm workspaces root
```

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

# 2. Install dependencies
npm install

# 3. Configure environment
cp .env.example .env
# Edit .env: set DATABASE_URL, TELEGRAM_BOT_TOKEN, KEYCRM_API_KEY, JWT_SECRET

# 4. Create database
createdb sb_agent
# If using non-default port:
# createdb -p 5433 sb_agent

# 5. Run migrations + seed
cd apps/backend
npx prisma migrate deploy
npx prisma db seed
cd ../..

# 6. Start all services
bash infra/scripts/dev.sh --all
```

This starts:
- Backend API on `http://localhost:3100`
- Admin panel on `http://localhost:3101`
- Telegram bot (long polling)

Login: default credentials from `.env` (`DEFAULT_ADMIN_USERNAME` / `DEFAULT_ADMIN_PASSWORD`).

### Individual services

```bash
bash infra/scripts/dev.sh           # Backend + Frontend only
bash infra/scripts/dev.sh --all     # + Telegram bot
```

## Production Deployment

### Server Requirements
- 2 vCPU / 4 GB RAM / 40 GB SSD minimum
- Ubuntu 22+ LTS
- PostgreSQL 15+
- Node.js 20+
- PM2 globally installed
- Nginx + Certbot
- Claude CLI authenticated

### Deploy

```bash
# 1. Provision server (first time)
bash infra/scripts/provision.sh

# 2. Configure .env on server
# Set all production values, especially:
# - DATABASE_URL with production password
# - Meta/Instagram tokens
# - TELEGRAM_BOT_TOKEN + TELEGRAM_MANAGER_GROUP_ID
# - JWT_SECRET (random 64 chars)
# - ADMIN_DOMAIN / API_DOMAIN

# 3. Deploy
bash infra/scripts/deploy.sh

# 4. Verify
pm2 ls                # All 4 processes online
curl https://api.status-blessed.com/health
```

### PM2 Process Names

All processes are prefixed with `INSTANCE_ID` in uppercase:

| Process | Description |
|---------|------------|
| `SB-api` | Fastify backend |
| `SB-bot` | Telegram bot |
| `SB-sync` | KeyCRM sync worker |
| `SB-admin` | Vue SPA serving |

---

## White-Label: Deploy for Another Brand

The platform is designed for multi-tenant deployment. Each brand gets its own instance with separate database, prompts, and integrations.

### Step-by-step

```bash
# 1. Clone the repo
git clone https://github.com/danylo-pavenko/platform-ai-agent-direct.git my-brand-agent
cd my-brand-agent

# 2. Create .env from template
cp .env.example .env
```

### Configure `.env`

Replace all brand-specific values:

```env
# Identity
INSTANCE_ID=mb                          # Short unique ID (used in PM2 names, DB, paths)
INSTANCE_NAME=MyBrand
BRAND_NAME=My Brand

# Domains
ADMIN_DOMAIN=admin.mybrand.com
API_DOMAIN=api.mybrand.com
API_PORT=3200                           # Different port per instance on same server
ADMIN_PORT=3201

# Database (separate DB per brand!)
DATABASE_URL=postgresql://mb_agent:PASSWORD@localhost:5432/mb_agent

# CRM (KeyCRM or skip)
CRM_PROVIDER=keycrm                     # Set to 'none' if no CRM
KEYCRM_API_KEY=your-key-here

# Instagram — separate Meta App per brand
META_APP_ID=...
META_APP_SECRET=...
IG_PAGE_ACCESS_TOKEN=...
IG_PAGE_ID=...

# Telegram — separate bot per brand
TELEGRAM_BOT_TOKEN=...
TELEGRAM_MANAGER_GROUP_ID=...

# Generate unique secrets
JWT_SECRET=$(openssl rand -hex 32)
```

### Customize Content

```bash
# 3. Edit brand-specific files:

# System prompt — the core AI personality and rules
apps/workspace/prompts/sales-agent.txt

# Knowledge base — brand info, contacts, FAQ
apps/workspace/knowledge/brand.txt
apps/workspace/knowledge/contacts.txt
apps/workspace/knowledge/delivery.txt
apps/workspace/knowledge/faq.txt

# catalog.txt is auto-generated by sync worker from CRM
```

### Database + Deploy

```bash
# 4. Create separate database
createdb mb_agent

# 5. Run migrations
cd apps/backend && npx prisma migrate deploy && npx prisma db seed && cd ../..

# 6. Nginx — copy and modify
sudo cp infra/nginx/sb-agent.conf /etc/nginx/sites-available/mb-agent.conf
# Edit: replace domains and ports
sudo ln -s /etc/nginx/sites-available/mb-agent.conf /etc/nginx/sites-enabled/
sudo certbot --nginx -d admin.mybrand.com -d api.mybrand.com
sudo nginx -t && sudo systemctl reload nginx

# 7. Start with PM2
INSTANCE_ID=mb pm2 start ecosystem.config.cjs
# Creates: MB-api, MB-bot, MB-sync, MB-admin
```

### What's Shared vs. Separate

| Shared (same code) | Separate (per brand) |
|---|---|
| Backend code | `.env` configuration |
| Frontend code | PostgreSQL database |
| Prisma schema | System prompt + knowledge files |
| Business logic | Meta App + IG page |
| PM2 ecosystem template | Telegram bot + group |
| Infrastructure scripts | Nginx server blocks |
| | PM2 process names |

### Multiple Brands on One Server

Each brand runs as 4 separate PM2 processes. Use different ports:

| Brand | API Port | Admin Port | PM2 Prefix |
|-------|----------|-----------|------------|
| Status Blessed | 3100 | 3101 | SB- |
| My Brand | 3200 | 3201 | MB- |
| Another Brand | 3300 | 3301 | AB- |

They can share the same PostgreSQL server (separate databases) and Nginx instance.

---

## Future Features (Post-Launch Roadmap)

The features below are validated against the current architecture and feasible as incremental additions. Ordered by impact and implementation complexity.

### High Impact, Low-Medium Effort

**1. Automated Regression Testing**
Run saved sandbox test cases automatically against new prompt versions before activation. Each test case already stores client questions; add expected-behavior assertions and an LLM-judge that evaluates responses. Block prompt activation if regressions detected.
- *Why:* Prevents prompt drift from breaking critical behaviors (pricing, escalation, safety).
- *Builds on:* Sandbox test cases (F.10), meta-agent (G.1-G.2), regression-tests.json (5.4).

**2. Analytics Dashboard**
Track key metrics: response times, conversations per day, handoff rate, order conversion, popular product queries, busiest hours. Store aggregated data in a `daily_stats` table, show charts in admin panel.
- *Why:* Data-driven decisions on bot behavior, staffing hours, and product positioning.
- *Builds on:* Existing conversation/message/order tables.

**3. Quick Reply Templates**
Allow managers to define canned responses for common questions (sizing, delivery times, payment methods). Bot suggests relevant templates; managers use them in handoff mode.
- *Why:* Faster manager responses during handoff, consistent messaging.
- *Builds on:* Settings key-value store, ConversationDetail view.

**4. Token Refresh Automation**
Auto-refresh Instagram Page Access Token before expiry. Store refresh token, run a cron check daily, alert via Telegram 7 days before expiry.
- *Why:* Prevents unexpected bot downtime from expired IG tokens.
- *Builds on:* Existing TG notification service.

### Medium Impact, Medium Effort

**5. Multi-Channel: Telegram Client DM**
Accept customer messages via a public-facing Telegram bot (separate from the manager bot). Same conversation routing, same Claude AI — different channel.
- *Why:* Expands reach; some customers prefer Telegram over Instagram.
- *Builds on:* Channel-agnostic conversation service, existing grammY setup.

**6. Product Image Search (Vision)**
When a customer sends a photo or screenshot, download it and pass to Claude with vision enabled. Claude identifies the product and suggests matches from the catalog.
- *Why:* Customers often send screenshots from IG posts or photos of items they want.
- *Builds on:* Media download (B.4), Claude image support (--image flag).

**7. Manager Reply Suggestions**
During handoff, generate AI draft responses for the manager. Manager sees the suggestion and can edit/send/reject.
- *Why:* Speeds up manager response time while maintaining human control.
- *Builds on:* askClaude service, ConversationDetail manual reply (F.9).

**8. Webhook Status Monitor**
Real-time health check for Instagram webhook. Track delivery rate, latency, errors. Alert if webhook stops receiving events (possible token expiry or Meta issue).
- *Why:* Proactive issue detection instead of waiting for customer complaints.
- *Builds on:* Webhook handler, TG notification service.

### Medium Impact, Higher Effort

**9. KeyCRM Order Push**
Automatically create orders in KeyCRM when manager approves. Map collected order fields to KeyCRM's `POST /order` API.
- *Why:* Eliminates manual order entry; single source of truth for fulfillment.
- *Builds on:* Order handler (H.2), KeyCRM client (D.1).

**10. A/B Prompt Testing**
Run two prompt versions simultaneously (50/50 split by conversation). Track metrics per version. Auto-promote the better performer after N conversations.
- *Why:* Data-driven prompt optimization instead of gut-feeling changes.
- *Builds on:* Prompt versioning, analytics (feature #2).

**11. Intents Dashboard**
Classify each conversation by intent (product inquiry, order, complaint, FAQ, etc.) using a lightweight Claude call. Show top-N intents per week with trends.
- *Why:* Understand what customers ask most, identify gaps in knowledge base.
- *Builds on:* Message data, existing Claude service.

**12. Multi-Language Support**
Detect customer language (Ukrainian, Russian, English) and respond accordingly. System prompt already handles Ukrainian/Russian; add explicit language detection and prompt variants for English.
- *Why:* Serve international customers and Russian-speaking Ukrainian customers better.
- *Builds on:* Prompt builder, Claude's native multilingual capability.

### Lower Priority (Nice-to-Have)

**13. Scheduled Messages**
Allow setting up automated messages (e.g., "Your order has been shipped") triggered by external events or time-based rules.

**14. Customer Profiles**
Enrich client records with purchase history, preferences, notes. Show in admin panel and inject relevant context into Claude prompts.

**15. Export/Reporting**
CSV/PDF export of conversations, orders, and analytics for accounting and business reporting.

**16. API Rate Limiting Dashboard**
Visualize Claude usage, IG API quota, KeyCRM rate limits in real-time. Predict when limits might be hit based on current traffic.

---

## Environment Variables Reference

See `.env.example` for the full list. Key groups:

| Group | Variables | Notes |
|-------|----------|-------|
| Identity | `INSTANCE_ID`, `INSTANCE_NAME`, `BRAND_NAME` | Short ID used in PM2, logs, prompts |
| Network | `API_PORT`, `ADMIN_PORT`, `ADMIN_DOMAIN`, `API_DOMAIN` | Ports unique per instance |
| Database | `DATABASE_URL` | Separate DB per brand |
| Instagram | `META_APP_*`, `IG_*` | Meta App credentials + webhook config |
| Telegram | `TELEGRAM_BOT_TOKEN`, `TELEGRAM_MANAGER_GROUP_ID`, `TELEGRAM_ADMIN_PASSWORD` | Bot + manager group |
| Claude | `CLAUDE_MAX_CONCURRENCY`, `CLAUDE_TIMEOUT_MS`, `CLAUDE_MODEL` | AI inference config |
| Auth | `JWT_SECRET`, `JWT_EXPIRES_IN` | Admin panel authentication |
| CRM | `CRM_PROVIDER`, `KEYCRM_API_KEY`, `KEYCRM_SYNC_INTERVAL_MIN` | Optional CRM integration |

---

## License

Private. All rights reserved.
