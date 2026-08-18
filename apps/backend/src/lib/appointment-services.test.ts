import { describe, expect, it } from 'vitest';
import {
  applyServiceMasterAssignments,
  backfillServiceMasterIds,
  normalizeAppointmentServices,
  parseMasterIdsFromOrderNote,
  uniqueMasterIds,
} from './appointment-services.js';

describe('appointment service masters', () => {
  it('parses one or more master_id markers from an order note', () => {
    const note =
      'Запис · 21.08.2026 12:00 master_id=88dd0fc4-da3d-e992-2008-7f0a230feb51 '
      + 'master_id=88de0aea-4b21-cc54-452f-f5687b3b1ec6 appointmentId=a0712020-04d1-4863-8ad4-1370d6905921';
    expect(parseMasterIdsFromOrderNote(note)).toEqual([
      '88dd0fc4-da3d-e992-2008-7f0a230feb51',
      '88de0aea-4b21-cc54-452f-f5687b3b1ec6',
    ]);
  });

  it('backfills missing masterId from the note fallback', () => {
    const { services, changed } = backfillServiceMasterIds(
      [
        { id: 'svc-1', durationMin: 115, name: 'Манікюр' },
        { id: 'svc-2', durationMin: 30, name: 'Укріплення', masterId: 'keep' },
      ],
      '88dd0fc4-da3d-e992-2008-7f0a230feb51',
    );
    expect(changed).toBe(true);
    expect(services[0]?.masterId).toBe('88dd0fc4-da3d-e992-2008-7f0a230feb51');
    expect(services[1]?.masterId).toBe('keep');
  });

  it('assigns masters by index without copying one id onto every line', () => {
    const next = applyServiceMasterAssignments(
      [
        { id: 'svc-1', durationMin: 115, name: 'Манікюр', masterId: 'a' },
        { id: 'svc-2', durationMin: 30, name: 'Укріплення', masterId: 'a' },
      ],
      [
        { index: 0, masterId: 'master-nails' },
        { index: 1, masterId: 'master-brows' },
      ],
    );
    expect(uniqueMasterIds(next)).toEqual(['master-nails', 'master-brows']);
  });

  it('normalizes mixed masterId / master_id keys from JSON', () => {
    const rows = normalizeAppointmentServices([
      { id: '1', duration_min: 60, master_id: 'pro-1' },
      { id: '2', durationMin: 30, masterId: 'pro-2' },
    ]);
    expect(rows.map((r) => r.masterId)).toEqual(['pro-1', 'pro-2']);
  });
});
