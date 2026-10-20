import type { Env } from '../env';
import { SELLER_REF_PATTERN } from './reference';
import { findSellerRef, type SellerRef, type SellerScope } from './seller-repo';
import { jsonError, scopeOf, type Ctx } from './staff-access';

export const sellerScopeOf = (c: Ctx): SellerScope => scopeOf(c);

/** Same 404 for malformed, unknown and out-of-scope references, so brokers cannot probe other brokers' sellers. */
export async function loadSeller(c: Ctx): Promise<SellerRef | Response> {
  const ref = c.req.param('ref') ?? '';
  if (!SELLER_REF_PATTERN.test(ref)) return jsonError(c, 404, 'NOT_FOUND', 'Seller not found.');
  return (await findSellerRef(c.env.DB, ref, sellerScopeOf(c))) ?? jsonError(c, 404, 'NOT_FOUND', 'Seller not found.');
}

/** Separation of duties is on unless explicitly disabled by configuration. */
export const separationEnforced = (env: Env): boolean => env.SELLER_SEPARATION_OF_DUTIES !== 'false';

/** Dual approval of material-interest notices is OFF unless the business adopts it. */
export const dualApprovalEnabled = (env: Env): boolean => env.SELLER_MATERIAL_INTEREST_DUAL_APPROVAL === 'true';
