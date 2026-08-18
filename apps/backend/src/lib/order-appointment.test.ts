import { describe, expect, it } from 'vitest';
import { parseAppointmentIdFromOrderNote } from './order-appointment.js';

describe('parseAppointmentIdFromOrderNote', () => {
  it('extracts UUID after appointmentId=', () => {
    expect(
      parseAppointmentIdFromOrderNote(
        'Запис: Комплекс манікюр · 21.08.2026 12:00\nappointmentId=a0712020-04d1-4863-8ad4-1370d6905921',
      ),
    ).toBe('a0712020-04d1-4863-8ad4-1370d6905921');
  });

  it('parses a single-line Moxito-style note and ignores master_id', () => {
    const note =
      'Запис: Комплекс манікюр, Укріплення нігтів короткі · 21.08.2026 12:00 '
      + 'master_id=88dd0fc4-da3d-e992-2008-7f0a230feb51 '
      + 'Коментар: Брови паралельно appointmentId=A0712020-04D1-4863-8AD4-1370D6905921';
    expect(parseAppointmentIdFromOrderNote(note)).toBe(
      'a0712020-04d1-4863-8ad4-1370d6905921',
    );
  });

  it('returns null when marker is missing', () => {
    expect(parseAppointmentIdFromOrderNote('Запис без id')).toBeNull();
    expect(parseAppointmentIdFromOrderNote(null)).toBeNull();
    expect(parseAppointmentIdFromOrderNote('')).toBeNull();
  });
});
