import { describe, expect, it } from 'vitest';
import {
  GENERIC_ENDPOINT_BLOCKED, SELLER_STATUSES, allowedTransitions, canTransition, genericTransitions, isTerminal, type SellerStatus,
} from '../../src/seller/lifecycle';

describe('seller lifecycle matrix', () => {
  it('permits the documented forward path', () => {
    const path: SellerStatus[] = ['NEW', 'ASSIGNED', 'CONTACT_ATTEMPTED', 'AWAITING_SELLER', 'QUALIFICATION', 'AUTHORITY_REVIEW', 'QUALIFIED', 'CONVERTED'];
    for (let i = 0; i < path.length - 1; i++) expect(canTransition(path[i]!, path[i + 1]!), `${path[i]} -> ${path[i + 1]}`).toBe(true);
    expect(canTransition('NEW', 'CONTACT_ATTEMPTED')).toBe(true);
    expect(canTransition('QUALIFICATION', 'QUALIFIED')).toBe(true);
  });
  it('blocks skipping stages', () => {
    for (const [from, to] of [['NEW', 'QUALIFIED'], ['NEW', 'CONVERTED'], ['ASSIGNED', 'QUALIFICATION'], ['CONTACT_ATTEMPTED', 'QUALIFIED'], ['QUALIFICATION', 'CONVERTED'], ['AUTHORITY_REVIEW', 'CONVERTED']] as const)
      expect(canTransition(from, to), `${from} -> ${to}`).toBe(false);
  });
  it('allows every open status to decline or close and no terminal status to move', () => {
    for (const s of SELLER_STATUSES) {
      if (isTerminal(s)) expect(allowedTransitions(s)).toEqual([]);
      else {
        expect(canTransition(s, 'DECLINED')).toBe(true);
        expect(canTransition(s, 'CLOSED')).toBe(true);
      }
    }
  });
  it('never lets a status move to itself', () => {
    for (const s of SELLER_STATUSES) expect(canTransition(s, s)).toBe(false);
  });
  it('keeps conversion off the generic status endpoint', () => {
    expect(GENERIC_ENDPOINT_BLOCKED).toContain('CONVERTED');
    expect(genericTransitions('QUALIFIED')).not.toContain('CONVERTED');
    expect(canTransition('QUALIFIED', 'CONVERTED')).toBe(true);
  });
});
