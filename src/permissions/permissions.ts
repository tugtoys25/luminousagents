/**
 * Single source of truth for what each staff role may do. Routes keep using `requireRole` with
 * the shared role lists; those lists are derived from here so the two cannot drift
 * (see test/unit/permissions.test.ts). New code should prefer `requirePermission`.
 */
export const STAFF_ROLES = ['super_admin', 'admin', 'publisher', 'editor', 'broker', 'auditor'] as const;
export type StaffRoleName = (typeof STAFF_ROLES)[number];

export const PERMISSIONS = {
  'listing.edit': ['super_admin', 'admin', 'editor', 'broker'],
  'listing.publish': ['super_admin', 'admin', 'publisher'],
  'staff.manage': ['super_admin', 'admin'],
  'mfa.reset': ['super_admin'],
  'audit.read': ['super_admin', 'admin', 'auditor'],
  // Seller workflow. Brokers see and work only enquiries assigned to them (record-level check in the repository);
  // assignment and closure decisions stay with managers (admin/super_admin). There is no separate compliance role yet.
  'seller_enquiries.read': ['super_admin', 'admin', 'broker'],
  'seller_enquiries.assign': ['super_admin', 'admin'],
  'seller_enquiries.update_status': ['super_admin', 'admin', 'broker'],
  'seller_enquiries.close': ['super_admin', 'admin'],
  'seller_enquiries.add_note': ['super_admin', 'admin', 'broker'],
  'seller_enquiries.record_communication': ['super_admin', 'admin', 'broker'],
  'seller_followups.manage': ['super_admin', 'admin', 'broker'],
} as const satisfies Record<string, readonly StaffRoleName[]>;
export type Permission = keyof typeof PERMISSIONS;

export function can(role: string, permission: Permission): boolean {
  return (PERMISSIONS[permission] as readonly string[]).includes(role);
}

/** Roles allowed for a permission, as a mutable list for `requireRole`. */
export function rolesFor(permission: Permission): string[] {
  return [...PERMISSIONS[permission]];
}
