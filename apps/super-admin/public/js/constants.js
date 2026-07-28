/** Shared Super Admin constants */
export const BASE = '/api';
export const SA_PAGE_KEY = 'sa_page';
export const VALID_PAGES = ['dashboard', 'tenants', 'workers', 'links', 'leads'];
export const DEFAULT_GIT_REPO = 'git@github.com:danylo-pavenko/platform-ai-agent-direct.git';
export const PLATFORM_BASE_DOMAIN = 'direct-ai-agents.com';
export const SLUG_RE = /^[a-z0-9-]{2,24}$/;
export const CHART_TZ = 'Europe/Kyiv';

export const fieldHints = {
  instanceId: 'Унікальний slug клієнта (2–24 символи). Використовується для доменів, Linux-користувача, PM2-префікса (CULTURA-api). Після створення змінити неможливо.',
  name: 'Назва бізнесу — відображається в списку клієнтів super-admin.',
  domainMode: 'Platform: автоматичні домени api-{slug}.direct-ai-agents.com. Custom: власні домени (legacy, окремий nginx vhost).',
  apiDomain: 'Публічний URL backend (webhook Meta, API). Nginx proxy_pass на API Port.',
  adminDomain: 'URL Vue-адмінки клієнта. Nginx проксіює на Admin Port.',
  apiPort: 'Локальний порт Fastify на VPS. Пари виділяються кроком +100 (3100, 3200…). Перевіряється реєстр + ss -tln.',
  adminPort: 'Локальний порт Vue admin (serve). Зазвичай API Port + 1.',
  status: 'Provisioned — запис у реєстрі, сервер ще не налаштовано. Active — розгорнуто на VPS. Suspended — блокує вхід у tenant admin.',
  accessMode: 'Обмеження підписки для tenant admin. Suspended має пріоритет над датою.',
  accessExpiresAt: 'Після цієї дати login у tenant admin буде заблоковано, доки не продовжать.',
  envExtra: 'Додаткові змінні в .env при provision/deploy. Формат: KEY=VALUE, одна на рядок. Не пишіть сюди LINUX_PASSWORD — для нього є окреме поле в Server setup.',
  linuxUser: 'Unix-користувач на VPS. Створюється provision-client.sh (з паролем + pm2 startup) при першому Provision.',
  linuxPassword: 'Пароль Linux-юзера на VPS (для sudo / інтерактивного входу). Якщо порожньо — згенерується при Provision. Зберігається в Extra env як LINUX_PASSWORD (не потрапляє в tenant .env).',
  appDir: 'Шлях до клону репозиторію на сервері (/home/{slug}/platform-ai-agent-direct).',
  gitRepo: 'SSH/HTTPS URL для першого git clone при Provision.',
  serverId: 'Worker VPS, на якому буде provision/deploy цього клієнта.',
};

export function readSavedPage() {
  const saved = localStorage.getItem(SA_PAGE_KEY);
  return VALID_PAGES.includes(saved) ? saved : 'dashboard';
}

export function emptyForm() {
  return {
    instanceId: '', name: '', domainMode: 'platform', apiDomain: '', adminDomain: '',
    apiPort: 3100, adminPort: 3101, linuxUser: '', appDir: '', status: 'provisioned',
    gitRepo: DEFAULT_GIT_REPO, envExtra: '', linuxPassword: '',
    instagramUserId: '', instagramRoutingIdsText: '',
    facebookAppSecret: '', accessMode: 'unlimited', accessExpiresAt: '',
    serverId: '',
  };
}

/** Read LINUX_PASSWORD from envExtra (provision-only). */
export function extractLinuxPassword(envExtra) {
  const parsed = String(envExtra || '').split('\n');
  for (const line of parsed) {
    const t = line.trim();
    if (t.startsWith('LINUX_PASSWORD=')) return t.slice('LINUX_PASSWORD='.length).trim();
  }
  return '';
}

/** Remove LINUX_PASSWORD lines from envExtra textarea display. */
export function stripLinuxPasswordFromEnvExtra(envExtra) {
  return String(envExtra || '')
    .split('\n')
    .filter((line) => {
      const t = line.trim();
      return !t.startsWith('LINUX_PASSWORD=');
    })
    .join('\n')
    .replace(/\n+$/, '');
}

/** Upsert LINUX_PASSWORD into envExtra before API save. */
export function withLinuxPasswordInEnvExtra(envExtra, linuxPassword) {
  const base = stripLinuxPasswordFromEnvExtra(envExtra);
  const pass = String(linuxPassword || '').trim();
  if (!pass) return base;
  return base ? `${base}\nLINUX_PASSWORD=${pass}` : `LINUX_PASSWORD=${pass}`;
}

export function emptyLinkForm() {
  return { name: '', slug: '', destinationUrl: '' };
}

export function platformDomainsForSlug(slug) {
  const s = String(slug || '').trim().toLowerCase();
  if (!s) return { apiDomain: '', adminDomain: '', linuxUser: '', appDir: '' };
  return {
    apiDomain: `api-${s}.${PLATFORM_BASE_DOMAIN}`,
    adminDomain: `agent-${s}.${PLATFORM_BASE_DOMAIN}`,
    linuxUser: s,
    appDir: `/home/${s}/platform-ai-agent-direct`,
  };
}

export function sanitizeSlug(raw) {
  return String(raw || '').toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 24);
}
