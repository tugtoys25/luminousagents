import { describe, expect, it } from 'vitest';
import {
  LIFECYCLE_STATES,
  allowedTransitions,
  checkLifecycleTransition,
  transitionMatrix,
} from '../../src/domain/opportunities/lifecycle';

describe('Sprint 32 lifecycle state machine', () => {
  it('never lets a draft jump straight to published', () => {
    const result = checkLifecycleTransition('draft', 'published', 'publisher');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('INVALID_LIFECYCLE_TRANSITION');
      expect(result.allowed).toContain('in_review');
      expect(result.allowed).not.toContain('published');
    }
    expect(checkLifecycleTransition('draft', 'published', 'super_admin').ok).toBe(false);
  });

  it('allows the normal path draft → in_review → published', () => {
    expect(checkLifecycleTransition('draft', 'in_review', 'publisher').ok).toBe(true);
    expect(checkLifecycleTransition('in_review', 'published', 'publisher').ok).toBe(true);
  });

  it('always allows staying in the same state so visibility can change on its own', () => {
    for (const state of LIFECYCLE_STATES) {
      expect(checkLifecycleTransition(state, state, 'publisher').ok).toBe(true);
    }
  });

  it('keeps archived terminal for publishers but lets administrators reopen it', () => {
    expect(allowedTransitions('archived', 'publisher')).toEqual(['archived']);
    expect(checkLifecycleTransition('archived', 'draft', 'publisher').ok).toBe(false);
    expect(checkLifecycleTransition('archived', 'draft', 'admin').ok).toBe(true);
    expect(checkLifecycleTransition('archived', 'draft', 'super_admin').ok).toBe(true);
  });

  it('lets only administrators reopen a sold listing for review', () => {
    expect(checkLifecycleTransition('sold', 'in_review', 'publisher').ok).toBe(false);
    expect(checkLifecycleTransition('sold', 'in_review', 'admin').ok).toBe(true);
  });

  it('rejects unknown states instead of guessing', () => {
    const result = checkLifecycleTransition('draft', 'live', 'admin');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('UNKNOWN_STATE');
    expect(checkLifecycleTransition(undefined, 'draft', 'admin').ok).toBe(false);
  });

  it('only allows non-admin roles a subset of what administrators may do', () => {
    const publisher = transitionMatrix('publisher');
    const admin = transitionMatrix('admin');
    for (const state of LIFECYCLE_STATES) {
      for (const next of publisher[state]) expect(admin[state]).toContain(next);
    }
  });

  it('every state can reach in_review or archived, so no listing is stranded', () => {
    for (const state of LIFECYCLE_STATES) {
      const reachable = allowedTransitions(state, 'admin');
      expect(reachable.includes('in_review') || reachable.includes('archived') || reachable.includes('draft')).toBe(true);
    }
  });
});
