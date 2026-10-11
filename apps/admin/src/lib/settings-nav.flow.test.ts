/**
 * End-to-end Settings IA flow for client message channels.
 * Walks the owner journey (nav → section → content kind), not isolated helpers.
 */
import { describe, expect, it } from 'vitest';
import {
  MESSAGE_SOURCES,
  MESSAGE_SOURCES_GROUP_LABEL,
} from './message-sources';
import {
  buildSettingsNavGroups,
  flattenSettingsNav,
  resolveClientChannelView,
  sectionNeedsIntegrationsLoad,
  settingsNavSelectItems,
  simulateOwnerSettingsJourney,
  visibleSettingsNavGroups,
} from './settings-nav';

describe('Settings · Канали з клієнтами (owner E2E flow)', () => {
  it('walks connect Instagram → peek WhatsApp stub → open manager Telegram', () => {
    const groups = visibleSettingsNavGroups(buildSettingsNavGroups(), true);

    // 1) First nav group is client channels (above System / CRM / Integrations)
    expect(groups[0]?.label).toBe(MESSAGE_SOURCES_GROUP_LABEL);
    expect(groups.map((g) => g.label)).toEqual([
      'Канали з клієнтами',
      'Система',
      'CRM і філії',
      'Інтеграції',
      'Акаунт',
    ]);

    const channels = groups[0]!.items;
    expect(channels.map((i) => i.id)).toEqual(MESSAGE_SOURCES.map((s) => s.sectionId));
    expect(channels.find((i) => i.id === 'settings-instagram')?.comingSoon).toBeFalsy();
    expect(channels.filter((i) => i.comingSoon).map((i) => i.id)).toEqual([
      'settings-whatsapp',
      'settings-viber',
      'settings-telegram-clients',
    ]);

    // 2) Integrations no longer owns Instagram; manager Telegram is renamed
    const integrations = groups.find((g) => g.label === 'Інтеграції')!;
    expect(integrations.items.map((i) => i.id)).not.toContain('settings-instagram');
    expect(integrations.items[0]).toMatchObject({
      id: 'settings-telegram',
      title: 'Telegram менеджерам',
    });

    // 3) Click path a tenant would take
    const journey = simulateOwnerSettingsJourney([
      'settings-instagram',
      'settings-whatsapp',
      'settings-viber',
      'settings-telegram-clients',
      'settings-telegram',
      'settings-instagram', // back from stub CTA
    ]);

    expect(journey.every((step) => step.known)).toBe(true);

    // Instagram: live OAuth pane + still loads Meta integrations
    expect(journey[0]).toMatchObject({
      channelView: { kind: 'live_instagram' },
      loadIntegrations: true,
      hash: '#settings-instagram',
    });

    // Coming-soon stubs: shared stub pane, never live Instagram, no Meta load required for WA/Viber/TG-clients
    for (const step of journey.slice(1, 4)) {
      expect(step.channelView.kind).toBe('coming_soon');
      if (step.channelView.kind === 'coming_soon') {
        expect(step.channelView.source.comingSoonBody?.length).toBeGreaterThan(20);
        expect(step.channelView.source.status).toBe('coming_soon');
      }
      expect(step.loadIntegrations).toBe(false);
      // Mutually exclusive with live Instagram view
      expect(resolveClientChannelView(step.sectionId).kind).not.toBe('live_instagram');
    }

    // Manager Telegram lives under Integrations (not a client channel)
    expect(journey[4]).toMatchObject({
      channelView: { kind: 'other' },
      loadIntegrations: true,
      hash: '#settings-telegram',
    });

    // Stub CTA «Налаштувати Instagram зараз» returns to live channel
    expect(journey[5].channelView.kind).toBe('live_instagram');
  });

  it('keeps manager Telegram distinct from client Telegram coming-soon', () => {
    const manager = resolveClientChannelView('settings-telegram');
    const clients = resolveClientChannelView('settings-telegram-clients');
    expect(manager.kind).toBe('other');
    expect(clients.kind).toBe('coming_soon');
    if (clients.kind === 'coming_soon') {
      expect(clients.source.title).toMatch(/клієнт/i);
      expect(clients.source.comingSoonBody).toMatch(/Telegram менеджерам/);
    }
    expect(sectionNeedsIntegrationsLoad('settings-telegram')).toBe(true);
    expect(sectionNeedsIntegrationsLoad('settings-telegram-clients')).toBe(false);
  });

  it('mobile select marks coming-soon and hash deep-links stay valid', () => {
    const flat = flattenSettingsNav(visibleSettingsNavGroups(buildSettingsNavGroups(), true));
    const select = settingsNavSelectItems(flat);

    const wa = select.find((i) => i.id === 'settings-whatsapp');
    expect(wa?.title).toBe('WhatsApp · Скоро');
    expect(select.find((i) => i.id === 'settings-instagram')?.title).toBe('Instagram');

    // Deep-link ids used in URL hash must all exist for owner
    for (const src of MESSAGE_SOURCES) {
      expect(flat.some((i) => i.id === src.sectionId)).toBe(true);
    }
  });

  it('manager role does not see client-channel or integrations groups', () => {
    const forManager = visibleSettingsNavGroups(buildSettingsNavGroups(), false);
    expect(forManager.map((g) => g.label)).toEqual(['Акаунт']);
    expect(forManager.flatMap((g) => g.items).map((i) => i.id)).not.toContain(
      'settings-instagram',
    );
  });
});
