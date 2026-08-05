import { describe, expect, it } from 'vitest';
import { wouldRemoveLastActiveOwner } from './admin-user-guards.js';

describe('wouldRemoveLastActiveOwner', () => {
  const owner = { role: 'owner' as const, isActive: true };
  const manager = { role: 'manager' as const, isActive: true };
  const inactiveOwner = { role: 'owner' as const, isActive: false };

  it('blocks demoting the last active owner', () => {
    expect(wouldRemoveLastActiveOwner(owner, { role: 'manager' }, 1)).toBe(true);
  });

  it('blocks deactivating the last active owner', () => {
    expect(wouldRemoveLastActiveOwner(owner, { isActive: false }, 1)).toBe(true);
  });

  it('allows demote when another active owner exists', () => {
    expect(wouldRemoveLastActiveOwner(owner, { role: 'manager' }, 2)).toBe(false);
  });

  it('allows deactivate when another active owner exists', () => {
    expect(wouldRemoveLastActiveOwner(owner, { isActive: false }, 2)).toBe(false);
  });

  it('allows promoting a manager to owner', () => {
    expect(wouldRemoveLastActiveOwner(manager, { role: 'owner' }, 1)).toBe(false);
  });

  it('allows reactivating an inactive owner', () => {
    expect(wouldRemoveLastActiveOwner(inactiveOwner, { isActive: true }, 0)).toBe(false);
  });

  it('allows no-op patch on last owner', () => {
    expect(wouldRemoveLastActiveOwner(owner, {}, 1)).toBe(false);
    expect(wouldRemoveLastActiveOwner(owner, { role: 'owner', isActive: true }, 1)).toBe(false);
  });

  it('blocks demote+deactivate combo on last owner', () => {
    expect(
      wouldRemoveLastActiveOwner(owner, { role: 'manager', isActive: false }, 1),
    ).toBe(true);
  });
});
