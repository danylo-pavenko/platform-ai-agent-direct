/**
 * End-to-end Sync page owner journey: hash → L1/L2 panes → exclusive content.
 * Covers deep-links, tab switches, service search — not isolated hash helpers alone.
 */
import { describe, expect, it } from 'vitest';
import {
  filterSyncedServices,
  resolveSyncPane,
  simulateSyncOwnerJourney,
  syncHeaderSubtitle,
  withCrmPane,
  withFilePane,
  withSyncSource,
  type SyncPaneId,
} from './sync-flow';
import { parseSyncHash, syncStateToHash, type SyncRouteState } from './sync-hash';
import type { SyncedService } from './sync-labels';

const ALL_PANES: SyncPaneId[] = [
  'crm-runs',
  'crm-services',
  'file-import',
  'file-products',
  'file-matches',
];

describe('Sync · owner E2E flow (CRM | Файл)', () => {
  it('walks CRM runs → services → file import → products → matches → back to CRM', () => {
    const journey = simulateSyncOwnerJourney([
      '#crm',
      '#crm-services',
      '#file',
      '#file-products',
      '#file-matches',
      '#crm',
    ]);

    expect(journey.map((s) => s.pane)).toEqual([
      'crm-runs',
      'crm-services',
      'file-import',
      'file-products',
      'file-matches',
      'crm-runs',
    ]);

    // Exactly one pane per step (mutual exclusion)
    for (const step of journey) {
      expect(ALL_PANES.filter((p) => p === step.pane)).toHaveLength(1);
      expect(step.hashOut).toBe(syncStateToHash(step.state));
      expect(parseSyncHash(step.hashOut)).toMatchObject(step.state);
      expect(step.subtitle.length).toBeGreaterThan(10);
    }

    // CRM vs file copy differs
    expect(journey[0].subtitle).toMatch(/CRM|04:00/);
    expect(journey[1].subtitle).toMatch(/послуг/i);
    expect(journey[2].subtitle).toMatch(/CSV|Shop-Express/i);
    expect(journey[3].subtitle).toMatch(/товар/i);
    expect(journey[4].subtitle).toMatch(/зв/i);
  });

  it('L1 source switch preserves sibling L2 panes in state', () => {
    let state: SyncRouteState = {
      source: 'crm',
      crmPane: 'services',
      filePane: 'matches',
    };

    state = withSyncSource(state, 'file');
    expect(state).toMatchObject({
      source: 'file',
      crmPane: 'services',
      filePane: 'matches',
    });
    expect(resolveSyncPane(state)).toBe('file-matches');
    expect(syncStateToHash(state)).toBe('#file-matches');

    state = withSyncSource(state, 'crm');
    expect(resolveSyncPane(state)).toBe('crm-services');
    expect(syncStateToHash(state)).toBe('#crm-services');
  });

  it('L2 setters force the matching L1 source', () => {
    const fromFile = withCrmPane(
      { source: 'file', crmPane: 'runs', filePane: 'products' },
      'services',
    );
    expect(fromFile).toMatchObject({ source: 'crm', crmPane: 'services' });
    expect(resolveSyncPane(fromFile)).toBe('crm-services');

    const fromCrm = withFilePane(
      { source: 'crm', crmPane: 'services', filePane: 'import' },
      'matches',
    );
    expect(fromCrm).toMatchObject({ source: 'file', filePane: 'matches' });
    expect(resolveSyncPane(fromCrm)).toBe('file-matches');
  });

  it('normalizes legacy / empty hashes to CRM runs', () => {
    for (const hash of ['', '#', '#unknown', '#crm-runs']) {
      const state = parseSyncHash(hash);
      expect(resolveSyncPane(state)).toBe('crm-runs');
      expect(syncStateToHash(state)).toBe('#crm');
    }
  });

  it('filters synced services by name, category, id, provider, grade', () => {
    const services: SyncedService[] = [
      {
        id: 'svc-1',
        name: 'Стрижка',
        price: 400,
        durationMin: 45,
        categoryName: 'Волосся',
        provider: 'beautypro',
        priceRows: [{ branchId: 'b1', positionName: 'Топ-майстер', price: 500 }],
      },
      {
        id: 'svc-2',
        name: 'Манікюр',
        price: 350,
        durationMin: 60,
        categoryName: 'Нігті',
        provider: 'altegio',
        priceRows: [],
      },
    ];

    expect(filterSyncedServices(services, '')).toHaveLength(2);
    expect(filterSyncedServices(services, 'стриж').map((s) => s.id)).toEqual(['svc-1']);
    expect(filterSyncedServices(services, 'нігт').map((s) => s.id)).toEqual(['svc-2']);
    expect(filterSyncedServices(services, 'топ-майстер').map((s) => s.id)).toEqual(['svc-1']);
    expect(filterSyncedServices(services, 'altegio').map((s) => s.id)).toEqual(['svc-2']);
    expect(filterSyncedServices(services, 'svc-1').map((s) => s.id)).toEqual(['svc-1']);
    expect(filterSyncedServices(services, 'немає')).toHaveLength(0);
  });

  it('every pane has a distinct subtitle for the page header', () => {
    const states: SyncRouteState[] = [
      { source: 'crm', crmPane: 'runs', filePane: 'import' },
      { source: 'crm', crmPane: 'services', filePane: 'import' },
      { source: 'file', crmPane: 'runs', filePane: 'import' },
      { source: 'file', crmPane: 'runs', filePane: 'products' },
      { source: 'file', crmPane: 'runs', filePane: 'matches' },
    ];
    const titles = states.map(syncHeaderSubtitle);
    expect(new Set(titles).size).toBe(titles.length);
  });
});
