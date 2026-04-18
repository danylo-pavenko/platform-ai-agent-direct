# Onboarding нового клієнта — покрокова інструкція

> Цей документ для тебе (super-admin / власник платформи).
> Описує повний процес від "новий клієнт погодився" до "бот відповідає в Instagram".

---

## Передумови (одноразово на сервер)

Якщо сервер ще не налаштований — виконай спочатку:

```bash
# 1. Базова ініціалізація сервера (пакети, PM2, Nginx, PostgreSQL)
CERTBOT_EMAIL=you@example.com bash infra/scripts/provision-server.sh

# 2. Super Admin дашборд
SUPER_ADMIN_DOMAIN=admin.yourplatform.com \
CERTBOT_EMAIL=you@example.com \
SUPER_ADMIN_REPO=https://github.com/yourorg/platform-super-admin.git \
bash infra/scripts/provision-super-admin.sh
```

Після цього зайди на `https://admin.yourplatform.com` і перевір що super-admin працює.

---

## Крок 1 — Вибір параметрів клієнта

Перед тим як виконувати скрипти — домовся з клієнтом про:

| Параметр | Приклад | Примітка |
|----------|---------|---------|
| `INSTANCE_ID` | `sb` | Коротко, лише латиниця, lowercase. Стане префіксом PM2, DB, Linux user. |
| `CLIENT_NAME` | `StatusBlessed` | Повна назва, без пробілів |
| `API_DOMAIN` | `api.status-blessed.com` | Домен клієнта, DNS A-record → IP сервера |
| `ADMIN_DOMAIN` | `agent.status-blessed.com` | Домен адмінки, DNS A-record → IP сервера |
| `API_PORT` | `3100` | Унікальний порт (3100, 3200, 3300...) |
| `ADMIN_PORT` | `3101` | Унікальний порт (3101, 3201, 3301...) |

**Таблиця зайнятих портів (оновлюй вручну):**

| Клієнт | INSTANCE_ID | API Port | Admin Port |
|--------|-------------|----------|------------|
| Status Blessed | sb | 3100 | 3101 |
| _(наступний)_ | — | 3200 | 3201 |
| _(наступний)_ | — | 3300 | 3301 |
| Super Admin | sa | 4000 | 4001 |

---

## Крок 2 — DNS записи

**Клієнт має налаштувати у себе в DNS панелі** (або ти, якщо домен у тебе):

```
api.status-blessed.com   A   <IP сервера>
agent.status-blessed.com A   <IP сервера>
```

Перевір що DNS propagated:
```bash
dig +short api.status-blessed.com
# має повернути IP сервера
```

---

## Крок 3 — Provision клієнта

Виконай **на сервері від root**:

```bash
CERTBOT_EMAIL=you@example.com \
PLATFORM_REPO=https://github.com/danylo-pavenko/platform-ai-agent-direct.git \
bash /opt/platform-admin/infra/scripts/provision-client.sh \
  sb StatusBlessed api.status-blessed.com agent.status-blessed.com 3100 3101
```

Скрипт:
- Створить Linux user `agent_sb`
- Створить БД `sb_agent` + user `sb_agent`
- Склонує репо в `/opt/agents/sb/`
- Згенерує `.env` з усіма параметрами
- Налаштує NGINX vhost + TLS сертифікати
- Зареєструє tenant у super-admin DB

Наприкінці скрипт виведе **credentials** — збережи їх.

---

## Крок 4 — Заповнення credentials клієнта

Зайди під юзером клієнта:
```bash
su - agent_sb
nano /opt/agents/sb/.env
```

Заповни ці поля (решта вже згенерована):

### Instagram / Meta
```env
META_APP_ID=         # з developers.facebook.com → App Settings → Basic
META_APP_SECRET=     # там само
IG_PAGE_ACCESS_TOKEN= # long-lived Page Access Token (інструкція нижче)
IG_PAGE_ID=          # Facebook Page ID
```

**Як отримати IG_PAGE_ACCESS_TOKEN:**
1. developers.facebook.com → Graph API Explorer
2. Application: вибери Meta App клієнта
3. User or Page → вибери Facebook Page клієнта
4. Generate Access Token з правами:
   - `instagram_basic`
   - `instagram_manage_messages`
   - `pages_messaging`
   - `pages_manage_metadata`
5. Конвертуй short → long-lived:
   ```
   GET https://graph.facebook.com/oauth/access_token
     ?grant_type=fb_exchange_token
     &client_id={META_APP_ID}
     &client_secret={META_APP_SECRET}
     &fb_exchange_token={SHORT_LIVED_TOKEN}
   ```
6. Скопіюй отриманий long-lived token в `.env`

> Token живе ~60 днів. Нагадай клієнту оновити або налаштуй авто-refresh.

### Telegram
```env
TELEGRAM_BOT_TOKEN=          # від @BotFather → /newbot
TELEGRAM_MANAGER_GROUP_ID=   # ID групи менеджерів (від'ємне число)
```

**Як отримати TELEGRAM_MANAGER_GROUP_ID:**
1. Створи групу, додай бота туди, зроби його адміном
2. Відправ будь-яке повідомлення в групу
3. `curl "https://api.telegram.org/bot{TOKEN}/getUpdates"` → знайди `chat.id`

### CRM (опціонально)
```env
CRM_PROVIDER=keycrm          # або 'none' якщо немає
KEYCRM_API_KEY=your-key
```

---

## Крок 5 — Автентифікація Claude Code

> Це **обовʼязковий ручний крок** — OAuth flow відкриває браузер.
> Виконується ОДИН РАЗ при onboarding клієнта.

```bash
su - agent_sb
claude auth login
# Відкриє посилання — відкрий в браузері
# Увійди в Claude акаунт КЛІЄНТА (або свій, якщо ліміти спільні)
# Після авторизації — claude збереже сесію для user agent_sb
```

Перевір що claude працює:
```bash
echo "ping" | claude -p "Відповідай одним словом: pong"
# Має вивести: pong
```

---

## Крок 6 — Деплой додатку

```bash
su - agent_sb
bash /opt/agents/sb/infra/scripts/deploy-client.sh
```

Скрипт:
- `git pull`
- `npm ci`
- `prisma migrate deploy` (створить всі таблиці + seed admin user)
- `npm run build:backend && npm run build:admin`
- `pm2 start ecosystem.config.cjs`

Перевір що все запустилось:
```bash
pm2 ls
# має бути: SB-api, SB-bot, SB-sync, SB-admin — всі online

curl https://api.status-blessed.com/health
# {"status":"ok","instance":"sb"}
```

---

## Крок 7 — Підключення Instagram Webhook

У Meta Dashboard → App → Instagram → Webhooks:

1. **Callback URL:** `https://api.status-blessed.com/webhooks/instagram`
2. **Verify Token:** значення `IG_WEBHOOK_VERIFY_TOKEN` з `.env` (наприклад `sb-verify-2026`)
3. Підпишись на поле: `messages`
4. Натисни "Verify and Save"

Перевірка:
- Надішли DM тестове повідомлення через IG → повинен з'явитись запис в БД
- `pm2 logs SB-api` — повинна бути ваша webhook entry

---

## Крок 8 — Заповнення Knowledge Base

Зайди в `/opt/agents/sb/apps/workspace/knowledge/` і заповни файли:

```bash
su - agent_sb
nano /opt/agents/sb/apps/workspace/knowledge/brand.txt      # бренд, tone of voice
nano /opt/agents/sb/apps/workspace/knowledge/contacts.txt   # контакти, графік
nano /opt/agents/sb/apps/workspace/knowledge/delivery.txt   # доставка, оплата
nano /opt/agents/sb/apps/workspace/knowledge/faq.txt        # FAQ
```

Системний промпт (sales agent) — редагується через адмінку:
`https://agent.status-blessed.com` → Системний промпт

---

## Крок 9 — Перший вхід в адмінку

URL: `https://agent.status-blessed.com`

Credentials з `.env`:
- Username: `admin` (або `DEFAULT_ADMIN_USERNAME`)
- Password: з `DEFAULT_ADMIN_PASSWORD` (виведено скриптом provision-client.sh)

**Після першого входу:**
1. Змінити пароль адміна
2. Перевірити налаштування → Working Hours
3. Перевірити системний промпт (Prompts)
4. Зробити тест через Sandbox

---

## Крок 10 — Фінальна перевірка

```bash
# Всі процеси online
pm2 ls | grep SB-

# Health check API
curl https://api.status-blessed.com/health

# Перевірка логів
pm2 logs SB-api --lines 20

# Тест Claude (від імені agent_sb user)
su - agent_sb
echo "Привіт" | claude -p "Ти консультант магазину. Відповідай по-українськи."
```

Надішли тестове DM в IG аккаунт клієнта → перевір відповідь бота.

---

## Довідка: що де знаходиться

| Що | Де |
|----|----|
| App dir | `/opt/agents/{instance_id}/` |
| .env | `/opt/agents/{instance_id}/.env` |
| Logs (PM2) | `pm2 logs {INSTANCE_ID_UPPER}-api` |
| DB | `{instance_id}_agent` (PostgreSQL) |
| Uploaded media | `/opt/agents/{instance_id}/uploads/` |
| NGINX config | `/etc/nginx/sites-available/{instance_id}-agent.conf` |
| TLS cert | `/etc/letsencrypt/live/{api_domain}/` |
| Workspace | `/opt/agents/{instance_id}/apps/workspace/` |

---

## Оновлення клієнта (після першого деплою)

```bash
su - agent_{instance_id}
bash /opt/agents/{instance_id}/infra/scripts/deploy-client.sh
```

Або через super-admin дашборд → Clients → Deploy.

---

## Troubleshooting

**PM2 процес не стартує:**
```bash
pm2 logs SB-api --lines 50
# Зазвичай: помилка у .env або незаповнені credentials
```

**Webhook не верифікується:**
```bash
# Перевір IG_WEBHOOK_VERIFY_TOKEN в .env
grep IG_WEBHOOK_VERIFY_TOKEN /opt/agents/sb/.env
# Має співпадати з тим що введено в Meta Dashboard
```

**Claude не відповідає:**
```bash
su - agent_sb
claude auth status
# Якщо не авторизований — повтори: claude auth login
```

**TLS сертифікат не отримано:**
```bash
# Перевір що DNS направлений правильно
dig +short api.status-blessed.com
certbot certonly --nginx -d api.status-blessed.com -d agent.status-blessed.com
```
