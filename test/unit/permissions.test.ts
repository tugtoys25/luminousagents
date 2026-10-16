import { describe, expect, it } from 'vitest';
import { can, rolesFor, PERMISSIONS, STAFF_ROLES } from '../../src/permissions/permissions';
import { editorRoles, publisherRoles } from '../../src/admin/shared';

describe('permissions', () => {
  it('matches the role lists used by the admin routes', () => {
    expect([...rolesFor('listing.edit')].sort()).toEqual([...editorRoles].sort());
    expect([...rolesFor('listing.publish')].sort()).toEqual([...publisherRoles].sort());
  });
  it('only grants known roles', () => {
    for (const roles of Object.values(PERMISSIONS))
      for (const r of roles) expect((STAFF_ROLES as readonly string[]).includes(r)).toBe(true);
  });
  it('denies unknown and unprivileged roles', () => {
    expect(can('buyer', 'listing.edit')).toBe(false);
    expect(can('auditor', 'listing.publish')).toBe(false);
    expect(can('editor', 'mfa.reset')).toBe(false);
    expect(can('super_admin', 'mfa.reset')).toBe(true);
  });
});
