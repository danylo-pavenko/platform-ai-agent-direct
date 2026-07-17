/**
 * Multi-bot Telegram config for tenant notifications.
 *
 * Stored inside settings.integration_telegram.bots[] with dual-write to legacy
 * flat botToken / managerGroupId / adminPassword (primary bot).
 */

import { randomUUID } from 'node:crypto';
import { sanitizeIntegrationSecret } from './integration-secrets.js';

export const TELEGRAM_NOTIFY_CHANNELS = [
  'handoff',
  'order',
  'brief',
  'agent_failure',
  'crm_fallback',
  'auth',
  'ops',
] as const;

export type TelegramNotifyChannel = (typeof TELEGRAM_NOTIFY_CHANNELS)[number];

export const TELEGRAM_CHANNEL_LABELS: Record<TelegramNotifyChannel, string> = {
  handoff: 'Ескалації / takeover',
  order: 'Замовлення',
  brief: 'Ліди / брифи',
  agent_failure: 'Помилки агента (Claude)',
  crm_fallback: 'CRM недоступна',
  auth: 'Auth / ліміти Claude / IG token',
  ops: 'Системні / тести / ops',
};

export interface TelegramBotConfig {
  id: string;
  label: string;
  /** Free-text role for meta-agent and system prompt (no secrets). */
  rolePrompt: string;
  botToken: string;
  adminPassword: string;
  managerGroupId: string;
  enabled: boolean;
  isPrimary: boolean;
  channels: TelegramNotifyChannel[];
}

export interface IntegrationTelegramMulti {
  botToken: string;
  managerGroupId: string;
  adminPassword: string;
  bots: TelegramBotConfig[];
}

const ALL_CHANNELS: TelegramNotifyChannel[] = [...TELEGRAM_NOTIFY_CHANNELS];

export function isTelegramNotifyChannel(value: unknown): value is TelegramNotifyChannel {
  return typeof value === 'string' && (TELEGRAM_NOTIFY_CHANNELS as readonly string[]).includes(value);
}

function parseChannels(raw: unknown): TelegramNotifyChannel[] {
  if (!Array.isArray(raw)) return [...ALL_CHANNELS];
  const parsed = raw.filter(isTelegramNotifyChannel);
  return parsed.length > 0 ? [...new Set(parsed)] : [...ALL_CHANNELS];
}

function parseBot(raw: unknown, index: number): TelegramBotConfig | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const id = typeof o.id === 'string' && o.id.trim() ? o.id.trim() : randomUUID();
  const label =
    typeof o.label === 'string' && o.label.trim()
      ? o.label.trim()
      : index === 0
        ? 'Основний бот'
        : `Бот ${index + 1}`;

  return {
    id,
    label,
    rolePrompt: typeof o.rolePrompt === 'string' ? o.rolePrompt : '',
    botToken: sanitizeIntegrationSecret(o.botToken),
    adminPassword: typeof o.adminPassword === 'string' ? o.adminPassword : '',
    managerGroupId: typeof o.managerGroupId === 'string' ? o.managerGroupId : '',
    enabled: o.enabled !== false,
    isPrimary: o.isPrimary === true,
    channels: parseChannels(o.channels),
  };
}

/** Ensure exactly one primary among enabled bots; dual-write flat legacy fields. */
export function normalizeTelegramConfig(raw: Partial<IntegrationTelegramMulti> | Record<string, unknown> | null | undefined): IntegrationTelegramMulti {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const flatToken = sanitizeIntegrationSecret(o.botToken);
  const flatGroup = typeof o.managerGroupId === 'string' ? o.managerGroupId : '';
  const flatPassword = typeof o.adminPassword === 'string' ? o.adminPassword : '';

  let bots: TelegramBotConfig[] = [];
  if (Array.isArray(o.bots)) {
    bots = o.bots
      .map((b, i) => parseBot(b, i))
      .filter((b): b is TelegramBotConfig => b !== null);
  }

  // Legacy → synthesize one primary bot
  if (bots.length === 0 && (flatToken || flatGroup || flatPassword)) {
    bots = [
      {
        id: 'primary',
        label: 'Основний бот',
        rolePrompt:
          'Основний бот для сповіщень менеджерам: ескалації, замовлення, ліди, системні алерти.',
        botToken: flatToken,
        adminPassword: flatPassword,
        managerGroupId: flatGroup,
        enabled: true,
        isPrimary: true,
        channels: [...ALL_CHANNELS],
      },
    ];
  }

  if (bots.length === 0) {
    return {
      botToken: '',
      managerGroupId: '',
      adminPassword: '',
      bots: [],
    };
  }

  // Exactly one primary
  const primaryIdx = bots.findIndex((b) => b.isPrimary && b.enabled);
  const fallbackIdx = bots.findIndex((b) => b.enabled) >= 0 ? bots.findIndex((b) => b.enabled) : 0;
  const chosenPrimary = primaryIdx >= 0 ? primaryIdx : fallbackIdx;
  bots = bots.map((b, i) => ({ ...b, isPrimary: i === chosenPrimary }));

  const primary = bots[chosenPrimary]!;
  if (!primary.botToken && flatToken) primary.botToken = flatToken;
  if (!primary.adminPassword && flatPassword) primary.adminPassword = flatPassword;
  if (!primary.managerGroupId && flatGroup) primary.managerGroupId = flatGroup;

  return {
    botToken: primary.botToken,
    managerGroupId: primary.managerGroupId,
    adminPassword: primary.adminPassword,
    bots,
  };
}

export function getPrimaryTelegramBot(
  cfg: IntegrationTelegramMulti | Partial<IntegrationTelegramMulti> | null | undefined,
): TelegramBotConfig | null {
  const normalized = normalizeTelegramConfig(cfg);
  return (
    normalized.bots.find((b) => b.isPrimary && b.enabled) ??
    normalized.bots.find((b) => b.enabled) ??
    null
  );
}

/**
 * Bots that should receive a notification of this category.
 * Fallback: primary (or first enabled) when nobody opted into the channel.
 */
export function resolveTelegramBotsForChannel(
  cfg: IntegrationTelegramMulti | Partial<IntegrationTelegramMulti> | null | undefined,
  channel: TelegramNotifyChannel,
): TelegramBotConfig[] {
  const normalized = normalizeTelegramConfig(cfg);
  const enabled = normalized.bots.filter((b) => b.enabled && b.botToken.trim());
  if (enabled.length === 0) return [];

  const matched = enabled.filter((b) => b.channels.includes(channel));
  if (matched.length > 0) return matched;

  const primary = getPrimaryTelegramBot(normalized);
  if (primary?.botToken.trim()) return [primary];
  return enabled.slice(0, 1);
}

/** Safe summary for agent prompts (no tokens / passwords). */
export function formatTelegramBotsPromptBlock(
  cfg: IntegrationTelegramMulti | Partial<IntegrationTelegramMulti> | null | undefined,
): string {
  const normalized = normalizeTelegramConfig(cfg);
  const enabled = normalized.bots.filter((b) => b.enabled);
  if (enabled.length === 0) {
    return '<telegram_bots>\n(не налаштовано)\n</telegram_bots>';
  }

  const lines = enabled.map((b) => {
    const channels = b.channels.map((c) => TELEGRAM_CHANNEL_LABELS[c] ?? c).join(', ');
    const role = b.rolePrompt.trim() || '(опис ролі не задано)';
    const primary = b.isPrimary ? ' [PRIMARY]' : '';
    return [
      `- ${b.label}${primary} (id=${b.id})`,
      `  role: ${role}`,
      `  channels: ${channels}`,
      b.managerGroupId.trim() ? `  group_id: ${b.managerGroupId.trim()}` : null,
    ]
      .filter(Boolean)
      .join('\n');
  });

  return [
    '<telegram_bots>',
    'Telegram-боти для сповіщень менеджерам (маршрутизація за типом події).',
    'Не вигадуй токени. Якщо клієнт питає куди піде лід/ескалація — дивись channels + role.',
    ...lines,
    '</telegram_bots>',
  ].join('\n');
}

/** Mask secrets inside bots[] for GET /integrations responses. */
export function maskTelegramBotsForResponse(raw: Record<string, unknown>): Record<string, unknown> {
  const normalized = normalizeTelegramConfig(raw);
  return {
    ...raw,
    botToken: normalized.botToken ? '••••••' : '',
    adminPassword: normalized.adminPassword ? '••••••' : '',
    managerGroupId: normalized.managerGroupId,
    bots: normalized.bots.map((b) => ({
      ...b,
      botToken: b.botToken ? '••••••' : '',
      adminPassword: b.adminPassword ? '••••••' : '',
    })),
  };
}

/**
 * Merge PUT payload for integration_telegram, preserving masked secrets
 * on flat fields and per-bot tokens/passwords (match by id).
 */
export function mergeTelegramIntegrationUpdate(
  existing: Record<string, unknown>,
  incoming: Record<string, unknown>,
  isMasked: (value: unknown) => boolean,
): Record<string, unknown> {
  const prev = normalizeTelegramConfig(existing);
  const nextBotsRaw = Array.isArray(incoming.bots) ? incoming.bots : null;

  const mergedFlat: Record<string, unknown> = { ...existing, ...incoming };

  if (isMasked(incoming.botToken)) mergedFlat.botToken = prev.botToken;
  if (isMasked(incoming.adminPassword)) mergedFlat.adminPassword = prev.adminPassword;

  if (nextBotsRaw) {
    const prevById = new Map(prev.bots.map((b) => [b.id, b]));
    const mergedBots = nextBotsRaw.map((raw, index) => {
      const parsed = parseBot(raw, index);
      if (!parsed) return null;
      const old = prevById.get(parsed.id);
      if (old) {
        if (isMasked(parsed.botToken) || !parsed.botToken) parsed.botToken = old.botToken;
        if (isMasked(parsed.adminPassword) || parsed.adminPassword === '••••••') {
          parsed.adminPassword = old.adminPassword;
        }
      }
      return parsed;
    }).filter((b): b is TelegramBotConfig => b !== null);

    mergedFlat.bots = mergedBots;
  }

  return normalizeTelegramConfig(mergedFlat) as unknown as Record<string, unknown>;
}
