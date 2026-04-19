# Onboarding нового клієнта — покрокова інструкція

> Документ для власника платформи (super-admin).
> Від "сервер чистий" до "бот відповідає в Instagram".

---

## Частина 1 — Підготовка сервера (один раз)

### Передумови

1. **VPS**: Ubuntu 24.04, мінімум 2 vCPU / 4 GB RAM / 40 GB SSD
2. **DNS записи** (зроби до запуску скрипту — certbot їх перевіряє):

   | Домен | Тип | Значення |
   |-------|-----|---------|
   | `direct-ai-agents.com` | A | IP сервера |
   | `www.direct-ai-agents.com` | A | IP сервера |
   | `admin.direct-ai-agents.com` | A | IP сервера |

3. **Перевір DNS** (з локального комп'ютера):
   ```bash
   dig +short direct-ai-agents.com
   dig +short admin.direct-ai-agents.com
   # Обидва мають вертати IP сервера
   ```

---

### Крок 1 — Клонувати репо на сервер і запустити provision

```bash
# Зайти на сервер
ssh root@<IP>

# Клонувати репо у тимчасове місце
git clone https://github.com/danylo-pavenko/platform-ai-agent-direct.git /tmp/platform

# Запустити provision (все в одному скрипті)
CERTBOT_EMAIL=hello@direct-ai-agents.com \
bash /tmp/platform/infra/scripts/provision-platform.sh
```

**Що зробить скрипт автоматично:**
- Встановить Node.js 20, PM2, Nginx, Certbot, PostgreSQL, UFW
- Створить Linux user `agentsadmin`
- Склонує репо в `/home/agentsadmin/platform-ai-agent-direct`
- Створить PostgreSQL БД `platform_admin` + таблицю `tenants`
- Налаштує NGINX для `direct-ai-agents.com` та `admin.direct-ai-agents.com`
- Отримає TLS сертифікати через Certbot
- Згенерує `.env.super-admin` з credentials

Наприкінці скрипт **виведе credentials** — обов'язково збережи їх.

---

### Крок 2 — Перевірити що лендинг піднявся

```bash
curl -I https://direct-ai-agents.com
# HTTP/2 200

curl -I https://www.direct-ai-agents.com
# HTTP/2 301 → redirect to direct-ai-agents.com
```

Відкрий `https://direct-ai-agents.com` в браузері — має з'явитись лендинг.

---

### Крок 3 — Super Admin app (коли буде готовий)

> Super Admin UI розробляється окремо (Блок I). Поки що NGINX для `admin.direct-ai-agents.com` вже налаштований і чекає на додаток на портах 4000/4001.

Коли super-admin app буде готовий:
```bash
su - agentsadmin
cd /home/agentsadmin/platform-ai-agent-direct

# Скопіювати .env
cp .env.super-admin .env

# Встановити залежності та запустити
npm install
pm2 start ecosystem.super-admin.config.cjs
pm2 save
```

---

## Частина 2 — Онбординг клієнта

### Крок 4 — Вибір параметрів клієнта

Перед виконанням скрипту визнач:

| Параметр | Приклад SB | Наступний клієнт |
|----------|-----------|-----------------|
| `INSTANCE_ID` | `sb` | `mb`, `xx`... |
| `CLIENT_NAME` | `StatusBlessed` | `MyBrand`... |
| `API_DOMAIN` | `api.status-blessed.com` | `api.mybrand.com` |
| `ADMIN_DOMAIN` | `agent.status-blessed.com` | `admin.mybrand.com` |
| `API_PORT` | `3100` | `3200`, `3300`... |
| `ADMIN_PORT` | `3101` | `3201`, `3301`... |

**Таблиця зайнятих портів (оновлюй вручну):**

| Клієнт | ID | API | Admin |
|--------|----|-----|-------|
| Super Admin | sa | 4000 | 4001 |
| Status Blessed | sb | 3100 | 3101 |
| _(наступний)_ | — | 3200 | 3201 |

---

### Крок 5 — DNS записи клієнта

Клієнт налаштовує у своїй DNS панелі (або ти, якщо домен у тебе):
```
api.status-blessed.com    A  <IP сервера>
agent.status-blessed.com  A  <IP сервера>
```

Перевірити:
```bash
dig +short api.status-blessed.com
```

---

### Крок 6 — Запустити provision клієнта

```bash
# Від root на сервері
CERTBOT_EMAIL=hello@direct-ai-agents.com \
PLATFORM_REPO=https://github.com/danylo-pavenko/platform-ai-agent-direct.git \
bash /home/agentsadmin/platform-ai-agent-direct/infra/scripts/provision-client.sh \
  sb StatusBlessed api.status-blessed.com agent.status-blessed.com 3100 3101
```

Скрипт:
- Створить Linux user `agent_sb`
- Створить БД `sb_agent` + user `sb_agent`
- Склонує репо в `/opt/agents/sb/`
- Згенерує `.env` (всі значення крім API credentials)
- Налаштує NGINX vhost + TLS
- Зареєструє tenant у `platform_admin.tenants`
- Виведе credentials: DB url, admin password, TG password

---

### Крок 7 — Заповнити credentials клієнта

```bash
su - agent_sb
nano /opt/agents/sb/.env
```

Заповни ці поля:

```env
# ── Instagram / Meta ──
META_APP_ID=          # developers.facebook.com → App → Settings → Basic
META_APP_SECRET=      # там само
IG_PAGE_ACCESS_TOKEN= # long-lived Page Access Token (інструкція нижче)
IG_PAGE_ID=           # Facebook Page ID (linked to IG Business)

# ── Telegram ──
TELEGRAM_BOT_TOKEN=           # від @BotFather → /newbot
TELEGRAM_MANAGER_GROUP_ID=    # ID групи менеджерів (від'ємне число)

# ── CRM (якщо є) ──
CRM_PROVIDER=keycrm           # або 'none'
KEYCRM_API_KEY=               # API ключ KeyCRM
```

**Як отримати IG_PAGE_ACCESS_TOKEN:**
1. [developers.facebook.com](https://developers.facebook.com) → Graph API Explorer
2. Application → вибери Meta App клієнта
3. User or Page → вибери Facebook Page клієнта
4. Generate Access Token з правами:
   `instagram_basic`, `instagram_manage_messages`, `pages_messaging`, `pages_manage_metadata`
5. Конвертуй short → long-lived (живе ~60 днів):
   ```
   GET https://graph.facebook.com/oauth/access_token
     ?grant_type=fb_exchange_token
     &client_id={META_APP_ID}
     &client_secret={META_APP_SECRET}
     &fb_exchange_token={SHORT_TOKEN}
   ```
6. Скопіюй отриманий token в `.env`

**Як отримати TELEGRAM_MANAGER_GROUP_ID:**
1. Створи TG групу, додай бота (`@StatusBlessedAdminBot`), зроби його адміном
2. Надішли будь-яке повідомлення в групу
3. `curl "https://api.telegram.org/bot{TOKEN}/getUpdates"` → знайди `chat.id` (від'ємне число)

---

### Крок 8 — Автентифікація Claude Code

> Єдиний ручний крок — OAuth через браузер. Виконується **один раз** при онбордингу.

```bash
su - agent_sb
claude auth login
# Відкриє посилання — відкрий в браузері
# Увійди в Claude акаунт (клієнта або свій)
```

Перевірка:
```bash
echo "ping" | claude -p "Say one word: pong"
# Відповідь: pong
```

---

### Крок 9 — Деплой

```bash
su - agent_sb
bash /opt/agents/sb/infra/scripts/deploy-client.sh
```

Скрипт зробить: `git pull` → `npm ci` → `prisma migrate deploy` (створить таблиці + seed admin) → build → `pm2 start`

Перевірка:
```bash
pm2 ls
# SB-api, SB-bot, SB-sync, SB-admin — всі online

curl https://api.status-blessed.com/health
# {"status":"ok","instance":"sb"}
```

---

### Крок 10 — Підключити Instagram Webhook

У [Meta Dashboard](https://developers.facebook.com) → App → Instagram → Webhooks:

1. **Callback URL:** `https://api.status-blessed.com/webhooks/instagram`
2. **Verify Token:** значення `IG_WEBHOOK_VERIFY_TOKEN` з `.env`
3. Підписатись на поле: `messages`
4. "Verify and Save"

---

### Крок 11 — Knowledge Base і перший вхід в адмінку

**Knowledge base:**
```bash
su - agent_sb
nano /opt/agents/sb/apps/workspace/knowledge/brand.txt
nano /opt/agents/sb/apps/workspace/knowledge/contacts.txt
nano /opt/agents/sb/apps/workspace/knowledge/delivery.txt
nano /opt/agents/sb/apps/workspace/knowledge/faq.txt
```

**Адмінка:**
- URL: `https://agent.status-blessed.com`
- Login/password: з `DEFAULT_ADMIN_USERNAME` / `DEFAULT_ADMIN_PASSWORD` в `.env`
- Після входу: змінити пароль, перевірити Prompts, зробити тест в Sandbox

---

### Крок 12 — Фінальний тест

1. Надішли DM в Instagram акаунт клієнта
2. Бот має відповісти протягом 10–30 секунд
3. Перевір логи: `pm2 logs SB-api --lines 30`

---

## Довідка — що де знаходиться

| Що | Де |
|----|----|
| Скрипти | `/home/agentsadmin/platform-ai-agent-direct/infra/scripts/` |
| Landing page | `/home/agentsadmin/platform-ai-agent-direct/infra/landing/index.html` |
| NGINX конфіг (platform) | `/etc/nginx/sites-available/platform.conf` |
| Super Admin .env | `/home/agentsadmin/platform-ai-agent-direct/.env.super-admin` |
| Super Admin DB | PostgreSQL: `platform_admin` |
| Client app dir | `/opt/agents/{id}/` |
| Client .env | `/opt/agents/{id}/.env` |
| Client NGINX | `/etc/nginx/sites-available/{id}-agent.conf` |
| Client PM2 logs | `pm2 logs {ID}-api` |
| TLS certs | `/etc/letsencrypt/live/{domain}/` |

---

## Оновлення клієнта (після першого деплою)

```bash
su - agent_{id}
bash /opt/agents/{id}/infra/scripts/deploy-client.sh
```

---

## Troubleshooting

**Лендинг не відкривається:**
```bash
nginx -t                          # перевір конфіг
systemctl status nginx            # статус
cat /etc/nginx/sites-enabled/platform.conf  # перевір шляхи
ls /home/agentsadmin/platform-ai-agent-direct/infra/landing/  # файли є?
```

**TLS сертифікат не отримано:**
```bash
# Перевір DNS
dig +short direct-ai-agents.com   # має бути IP сервера

# Повторити вручну
certbot certonly --nginx \
  -d direct-ai-agents.com -d www.direct-ai-agents.com \
  --email hello@direct-ai-agents.com --agree-tos --non-interactive
```

**PM2 процес не стартує:**
```bash
pm2 logs SB-api --lines 50
# Зазвичай: помилка у .env або не заповнені credentials
```

**Claude не авторизований:**
```bash
su - agent_{id}
claude auth status
claude auth login   # повторити якщо потрібно
```

**Webhook не верифікується:**
```bash
grep IG_WEBHOOK_VERIFY_TOKEN /opt/agents/sb/.env
# Порівняй з тим що введено в Meta Dashboard
```
