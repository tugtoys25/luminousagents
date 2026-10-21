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

