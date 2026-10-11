/**
 * Sprint 32 — opportunity lifecycle state machine.
 *
 * Pure and dependency-free so it can be unit tested without a Worker or a database.
 * The publication route calls `checkLifecycleTransition` before it writes anything.
 *
 * Rules:
 * - Moving to the state a listing is already in is always allowed (used to change visibility only).
 * - `published` can only be entered from `in_review`, or re-entered from the paused states
 *   (`on_hold`, `under_offer`). A draft can never jump straight to published.
 * - Reaching `published` also still needs approved content, a public classification and a
 *   verification date; that guard stays in the publication route.
 * - `admin` and `super_admin` get a small, explicit set of extra moves for corrections.
 */

export const LIFECYCLE_STATES = [
  'draft',
  'in_review',
  'published',
  'on_hold',
  'under_offer',
  'sold',
  'off_market',
  'archived',
] as const;

export type LifecycleState = (typeof LIFECYCLE_STATES)[number];

const STANDARD: Record<LifecycleState, readonly LifecycleState[]> = {
  draft: ['in_review', 'archived'],
  in_review: ['draft', 'published', 'archived'],
  published: ['in_review', 'on_hold', 'under_offer', 'sold', 'off_market', 'archived'],
  on_hold: ['published', 'in_review', 'off_market', 'archived'],
  under_offer: ['published', 'on_hold', 'sold', 'off_market', 'archived'],
  sold: ['archived'],
  off_market: ['in_review', 'archived'],
  archived: [],
};

/** Extra moves only an administrator may make, e.g. re-opening a sold or archived listing for review. */
const ADMIN_EXTRA: Record<LifecycleState, readonly LifecycleState[]> = {
  draft: [],
  in_review: [],
  published: [],
  on_hold: [],
  under_offer: [],
  sold: ['in_review', 'on_hold', 'off_market'],
  off_market: ['draft', 'on_hold'],
  archived: ['draft', 'in_review'],
};

const ADMIN_ROLES = new Set(['admin', 'super_admin']);

export function isLifecycleState(value: unknown): value is LifecycleState {
  return typeof value === 'string' && (LIFECYCLE_STATES as readonly string[]).includes(value);
}

export function allowedTransitions(from: LifecycleState, role: string): LifecycleState[] {
  const extra = ADMIN_ROLES.has(role) ? ADMIN_EXTRA[from] : [];
  return [...new Set<LifecycleState>([from, ...STANDARD[from], ...extra])];
}

export type TransitionCheck =
  | { ok: true }
  | { ok: false; code: 'UNKNOWN_STATE' | 'INVALID_LIFECYCLE_TRANSITION'; message: string; allowed: LifecycleState[] };

export function checkLifecycleTransition(from: unknown, to: unknown, role: string): TransitionCheck {
  if (!isLifecycleState(from) || !isLifecycleState(to)) {
    return {
      ok: false,
      code: 'UNKNOWN_STATE',
      message: 'The current or requested lifecycle state is not recognised.',
      allowed: [],
    };
  }
  const allowed = allowedTransitions(from, role);
  if (allowed.includes(to)) return { ok: true };
  return {
    ok: false,
    code: 'INVALID_LIFECYCLE_TRANSITION',
    message: `A listing in "${from}" cannot move to "${to}". Allowed next states: ${allowed.join(', ')}.`,
    allowed,
  };
}

/** Full matrix for documentation and the transitions endpoint. */
export function transitionMatrix(role: string): Record<LifecycleState, LifecycleState[]> {
  const result = {} as Record<LifecycleState, LifecycleState[]>;
  for (const state of LIFECYCLE_STATES) result[state] = allowedTransitions(state, role);
  return result;
}
