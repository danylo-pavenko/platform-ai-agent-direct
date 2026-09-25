import { describe, expect, it } from 'vitest';
import {
  crmPersonFullName,
  effectiveChatDisplayName,
  effectiveClientPersonName,
  igProfilePersonName,
  isIgProfileTitleNotPersonName,
  isPlausiblePersonName,
} from './client-person-name.js';

describe('isIgProfileTitleNotPersonName', () => {
  it('flags Instagram business headlines', () => {
    expect(
      isIgProfileTitleNotPersonName('Йога для вагітних і після пологів'),
    ).toBe(true);
    expect(isIgProfileTitleNotPersonName('Особистий тренер · Львів')).toBe(true);
  });

  it('does not flag ordinary names', () => {
    expect(isIgProfileTitleNotPersonName('Діана')).toBe(false);
    expect(isIgProfileTitleNotPersonName('Тимофіїв Анжела')).toBe(false);
  });
});

describe('isPlausiblePersonName', () => {
  it('accepts a first name or ПІБ', () => {
    expect(isPlausiblePersonName('Діана')).toBe(true);
    expect(isPlausiblePersonName('Тимофіїв Анжела')).toBe(true);
  });

  it('rejects greetings and slogans', () => {
    expect(isPlausiblePersonName('Доброго дня')).toBe(false);
    expect(isPlausiblePersonName('Йога для вагітних і після пологів')).toBe(false);
  });
});

describe('effectiveChatDisplayName', () => {
  it('ignores a displayName copied from the IG headline', () => {
    expect(
      effectiveChatDisplayName(
        'Йога для вагітних і після пологів',
        'Йога для вагітних і після пологів',
      ),
    ).toBeUndefined();
  });

  it('keeps the name the client said in chat', () => {
    expect(
      effectiveChatDisplayName('Діана', 'Йога для вагітних і після пологів'),
    ).toBe('Діана');
  });

  it('does not treat an IG-copied person name as chat-collected', () => {
    expect(effectiveChatDisplayName('Олена Коваль', 'Олена Коваль')).toBeUndefined();
  });
});

describe('igProfilePersonName', () => {
  it('accepts a real-looking profile name', () => {
    expect(igProfilePersonName('Олена Коваль')).toBe('Олена Коваль');
    expect(igProfilePersonName('Діана')).toBe('Діана');
    expect(igProfilePersonName('Diana Dombek')).toBe('Diana Dombek');
  });

  it('skips slogans and one-word Latin brands, keeps given names', () => {
    expect(igProfilePersonName('Йога для вагітних і після пологів')).toBeUndefined();
    expect(igProfilePersonName('Moxito')).toBeUndefined();
    expect(igProfilePersonName('Marta')).toBe('Marta');
    expect(igProfilePersonName('Anna')).toBe('Anna');
  });
});

describe('effectiveClientPersonName', () => {
  it('uses Latin IG given name when chat name is missing', () => {
    expect(effectiveClientPersonName(null, 'Marta')).toBe('Marta');
  });

  it('uses a person-like IG name when chat name is missing', () => {
    expect(effectiveClientPersonName(null, 'Олена Коваль')).toBe('Олена Коваль');
  });

  it('prefers the chat name over the IG name', () => {
    expect(effectiveClientPersonName('Діана', 'Олена Коваль')).toBe('Діана');
  });
});

describe('crmPersonFullName', () => {
  it('does not write an IG headline into CRM', () => {
    expect(
      crmPersonFullName({
        displayName: 'Йога для вагітних і після пологів',
        igFullName: 'Йога для вагітних і після пологів',
        igUsername: 'diana.dombek',
      }),
    ).toBe('@diana.dombek');
  });

  it('prefers the chat name', () => {
    expect(
      crmPersonFullName({
        displayName: 'Діана',
        igFullName: 'Йога для вагітних і після пологів',
        igUsername: 'diana.dombek',
      }),
    ).toBe('Діана');
  });

  it('uses a person-like IG name when chat name is missing', () => {
    expect(
      crmPersonFullName({
        displayName: null,
        igFullName: 'Олена Коваль',
        igUsername: 'olena.k',
      }),
    ).toBe('Олена Коваль');
  });

  it('uses an IG-seeded Latin given name for CRM full name', () => {
    expect(
      crmPersonFullName({
        displayName: 'Marta',
        igFullName: 'Marta',
        igUsername: 'martavibe.s',
      }),
    ).toBe('Marta');
  });
});
