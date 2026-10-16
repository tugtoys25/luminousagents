import type { MiddlewareHandler } from 'hono';
import { requireRole, type StaffApp } from '../auth/staff-session';
import { rolesFor, type Permission } from './permissions';

/** Permission-based guard; identical 403 behaviour to `requireRole`. */
export function requirePermission(permission: Permission): MiddlewareHandler<StaffApp> {
  return requireRole(...rolesFor(permission));
}
