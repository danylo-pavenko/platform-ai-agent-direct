/**
 * Client-facing message channels (Instagram DM today; WhatsApp / Viber /
 * client Telegram later). Manager Telegram alerts stay under Integrations.
 */

export type MessageSourceStatus = 'live' | 'coming_soon';

export type MessageSourceId = 'instagram' | 'whatsapp' | 'viber' | 'telegram_clients';

export interface MessageSource {
  id: MessageSourceId;
  /** Settings section hash / activeSection id */
  sectionId: string;
  title: string;
  icon: string;
  status: MessageSourceStatus;
  /** One-line why this channel matters for the tenant */
  whyItMatters: string;
  /** Longer copy for coming-soon stub pages */
  comingSoonBody?: string;
}

export const MESSAGE_SOURCES: MessageSource[] = [
  {
    id: 'instagram',
    sectionId: 'settings-instagram',
    title: 'Instagram',
    icon: 'mdi-instagram',
    status: 'live',
    whyItMatters:
      'Direct від клієнтів і відповіді менеджерів з додатку Instagram потрапляють сюди лише після підключення.',
  },
  {
    id: 'whatsapp',
    sectionId: 'settings-whatsapp',
    title: 'WhatsApp',
    icon: 'mdi-whatsapp',
    status: 'coming_soon',
    whyItMatters: 'Другий канал продажів — клієнти часто пишуть у WhatsApp поруч з Instagram.',
    comingSoonBody:
      'Невдовзі можна буде підключити WhatsApp Business, щоб агент відповідав клієнтам і там. Зараз основний канал — Instagram Direct.',
  },
  {
    id: 'viber',
    sectionId: 'settings-viber',
    title: 'Viber',
    icon: 'mdi-chat-outline',
    status: 'coming_soon',
    whyItMatters: 'Популярний месенджер в Україні — зручний додатковий канал для клієнтів.',
    comingSoonBody:
      'Підключення Viber для діалогів з клієнтами зʼявиться пізніше. Поки що приймайте звернення через Instagram.',
  },
  {
    id: 'telegram_clients',
    sectionId: 'settings-telegram-clients',
    title: 'Telegram (клієнти)',
    icon: 'mdi-send',
    status: 'coming_soon',
    whyItMatters: 'Окремий канал для діалогів з клієнтами в Telegram (не сповіщення менеджерам).',
    comingSoonBody:
      'Це майбутній канал для повідомлень клієнтів у Telegram. Сповіщення адміністраторам уже налаштовуються в розділі «Telegram менеджерам» у блоці Інтеграції.',
  },
];

export const MESSAGE_SOURCES_GROUP_LABEL = 'Канали з клієнтами';

export function liveMessageSources(): MessageSource[] {
  return MESSAGE_SOURCES.filter((s) => s.status === 'live');
}

export function comingSoonMessageSources(): MessageSource[] {
  return MESSAGE_SOURCES.filter((s) => s.status === 'coming_soon');
}

export function messageSourceBySectionId(sectionId: string): MessageSource | undefined {
  return MESSAGE_SOURCES.find((s) => s.sectionId === sectionId);
}

export function isComingSoonMessageSourceSection(sectionId: string): boolean {
  const src = messageSourceBySectionId(sectionId);
  return src?.status === 'coming_soon';
}

/** Nav items derived from the registry (for Settings sidebar / mobile select). */
export function messageSourceNavItems(): Array<{
  id: string;
  title: string;
  icon: string;
  comingSoon: boolean;
}> {
  return MESSAGE_SOURCES.map((s) => ({
    id: s.sectionId,
    title: s.title,
    icon: s.icon,
    comingSoon: s.status === 'coming_soon',
  }));
}
