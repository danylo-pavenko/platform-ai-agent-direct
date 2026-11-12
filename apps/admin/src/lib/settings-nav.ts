/**
 * Settings sidebar composition — shared by SettingsView and flow tests.
 * Client channels come from message-sources registry; CRM/ops stay separate.
 */

import {
  MESSAGE_SOURCES_GROUP_LABEL,
  messageSourceBySectionId,
  messageSourceNavItems,
  type MessageSource,
} from './message-sources';

export type SettingsNavItem = {
  id: string;
  title: string;
  icon: string;
  comingSoon?: boolean;
  /** Must be configured before the bot can serve customers. */
  requiredForGoLive?: boolean;
};

export type SettingsNavGroup = {
  label: string;
  ownerOnly: boolean;
  items: SettingsNavItem[];
};

/** Setup badge for required (and optionally other) nav rows. */
export type SettingsNavSetupStatus = 'ok' | 'needed' | 'warn' | 'unknown' | 'soon';

export function resolveInstagramNavStatus(input: {
  pageId?: string | null;
  igUserId?: string | null;
  hasToken?: boolean;
}): SettingsNavSetupStatus {
  const hasPage = !!(input.pageId?.trim() || input.hasToken);
  const hasIg = !!input.igUserId?.trim();
  if (hasPage && hasIg) return 'ok';
  if (hasPage && !hasIg) return 'warn';
  return 'needed';
}

export function resolveClaudeNavStatus(input: {
  loaded: boolean;
  loggedIn?: boolean;
  sessionExpired?: boolean;
  binaryOk?: boolean;
}): SettingsNavSetupStatus {
  if (!input.loaded) return 'unknown';
  if (input.loggedIn) return 'ok';
  if (input.binaryOk === false) return 'needed';
  if (input.sessionExpired) return 'needed';
  return 'needed';
}

export function settingsNavStatusLabel(status: SettingsNavSetupStatus): string {
  switch (status) {
    case 'ok':
      return 'Готово';
    case 'needed':
      return 'Потрібно';
    case 'warn':
      return 'Доповнити';
    case 'soon':
      return 'Скоро';
    default:
      return '';
  }
}

export function settingsNavStatusColor(status: SettingsNavSetupStatus): string {
  switch (status) {
    case 'ok':
      return 'success';
    case 'needed':
      return 'warning';
    case 'warn':
      return 'orange';
    case 'soon':
      return 'grey';
    default:
      return 'grey';
  }
}

/** Sections that must load Meta/CRM integration payloads. */
export const INTEGRATION_SECTION_IDS = [
  'settings-instagram',
  'settings-telegram',
  'settings-keycrm',
  'settings-cleverbox',
  'settings-beautypro',
  'settings-altegio',
  'settings-novaposhta',
] as const;

export function buildSettingsNavGroups(): SettingsNavGroup[] {
  return [
    {
      label: MESSAGE_SOURCES_GROUP_LABEL,
      ownerOnly: true,
      items: messageSourceNavItems().map((item) => ({
        id: item.id,
        title: item.title,
        icon: item.icon,
        comingSoon: item.comingSoon,
        requiredForGoLive: item.id === 'settings-instagram',
      })),
    },
    {
      label: 'Система',
      ownerOnly: true,
      items: [
        { id: 'settings-health', title: 'Health Check', icon: 'mdi-heart-pulse' },
        {
          id: 'settings-claude',
          title: 'Claude',
          icon: 'mdi-robot',
          requiredForGoLive: true,
        },
        { id: 'settings-runtime', title: 'Кому відповідає бот', icon: 'mdi-toggle-switch' },
        { id: 'settings-agent', title: 'Агент і SLA', icon: 'mdi-head-cog' },
      ],
    },
    {
      label: 'CRM і філії',
      ownerOnly: true,
      items: [
        { id: 'settings-crm-routing', title: 'CRM routing', icon: 'mdi-routes' },
        { id: 'settings-branches', title: 'Філії', icon: 'mdi-store-marker' },
      ],
    },
    {
      label: 'Інтеграції',
      ownerOnly: true,
      items: [
        { id: 'settings-telegram', title: 'Telegram менеджерам', icon: 'mdi-send' },
        { id: 'settings-keycrm', title: 'KeyCRM', icon: 'mdi-database' },
        { id: 'settings-cleverbox', title: 'CleverBOX', icon: 'mdi-calendar-clock' },
        { id: 'settings-beautypro', title: 'BeautyPro', icon: 'mdi-spa' },
        { id: 'settings-altegio', title: 'Altegio', icon: 'mdi-calendar-account' },
        { id: 'settings-novaposhta', title: 'Нова Пошта', icon: 'mdi-truck-fast' },
      ],
    },
    {
      label: 'Акаунт',
      ownerOnly: false,
      items: [{ id: 'settings-account', title: 'Обліковий запис', icon: 'mdi-account-key' }],
    },
  ];
}

export function visibleSettingsNavGroups(
  groups: SettingsNavGroup[],
  isOwner: boolean,
): SettingsNavGroup[] {
  return groups.filter((g) => !g.ownerOnly || isOwner);
}

export function flattenSettingsNav(groups: SettingsNavGroup[]): SettingsNavItem[] {
  return groups.flatMap((g) => [...g.items]);
}

/**
 * Mobile select labels — coming-soon + go-live setup status markers.
 */
export function settingsNavSelectItems(
  items: SettingsNavItem[],
  statusById: Partial<Record<string, SettingsNavSetupStatus>> = {},
): SettingsNavItem[] {
  return items.map((item) => {
    if (item.comingSoon) {
      return { ...item, title: `${item.title} · Скоро` };
    }
    const status = statusById[item.id];
    const label = status ? settingsNavStatusLabel(status) : '';
    if (!label || status === 'unknown') return { ...item };
    return { ...item, title: `${item.title} · ${label}` };
  });
}

export function isKnownSettingsSection(
  groups: SettingsNavGroup[],
  sectionId: string,
): boolean {
  return flattenSettingsNav(groups).some((i) => i.id === sectionId);
}

export type ClientChannelView =
  | { kind: 'live_instagram' }
  | { kind: 'coming_soon'; source: MessageSource }
  | { kind: 'other' };

/**
 * What the Settings content pane should render for a section id
 * (client-channel slice of the screen).
 */
export function resolveClientChannelView(sectionId: string): ClientChannelView {
  if (sectionId === 'settings-instagram') return { kind: 'live_instagram' };
  const src = messageSourceBySectionId(sectionId);
  if (src?.status === 'coming_soon') return { kind: 'coming_soon', source: src };
  return { kind: 'other' };
}

export function sectionNeedsIntegrationsLoad(sectionId: string): boolean {
  return (INTEGRATION_SECTION_IDS as readonly string[]).includes(sectionId);
}

/**
 * Simulate owner clicking through Settings: hash deep-link + content kind.
 * Returns the view after each step (for flow tests).
 */
export function simulateOwnerSettingsJourney(steps: string[]): Array<{
  sectionId: string;
  known: boolean;
  channelView: ClientChannelView;
  loadIntegrations: boolean;
  hash: string;
}> {
  const groups = visibleSettingsNavGroups(buildSettingsNavGroups(), true);
  return steps.map((sectionId) => {
    const known = isKnownSettingsSection(groups, sectionId);
    return {
      sectionId,
      known,
      channelView: resolveClientChannelView(sectionId),
      loadIntegrations: sectionNeedsIntegrationsLoad(sectionId),
      hash: `#${sectionId}`,
    };
  });
}
