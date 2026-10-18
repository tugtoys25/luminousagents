/**
 * Seller enquiry lifecycle. Pure module (no framework imports) so the matrix is unit-testable and the single
 * source of truth for the server. QUALIFIED means the lead meets qualification criteria; CONVERTED means an explicit
 * conversion was recorded. Neither proves a legally sufficient mandate exists.
 */
export const SELLER_STATUSES = ['NEW', 'ASSIGNED', 'CONTACT_ATTEMPTED', 'AWAITING_SELLER', 'QUALIFICATION', 'AUTHORITY_REVIEW', 'QUALIFIED', 'CONVERTED', 'DECLINED', 'CLOSED'] as const;
export type SellerStatus = (typeof SELLER_STATUSES)[number];

export const TERMINAL_STATUSES: readonly SellerStatus[] = ['CONVERTED', 'DECLINED', 'CLOSED'];

const TRANSITIONS: Record<SellerStatus, readonly SellerStatus[]> = {
  NEW: ['ASSIGNED', 'CONTACT_ATTEMPTED', 'DECLINED', 'CLOSED'],
  ASSIGNED: ['CONTACT_ATTEMPTED', 'DECLINED', 'CLOSED'],
  CONTACT_ATTEMPTED: ['AWAITING_SELLER', 'QUALIFICATION', 'DECLINED', 'CLOSED'],
  AWAITING_SELLER: ['CONTACT_ATTEMPTED', 'QUALIFICATION', 'DECLINED', 'CLOSED'],
  QUALIFICATION: ['AWAITING_SELLER', 'AUTHORITY_REVIEW', 'QUALIFIED', 'DECLINED', 'CLOSED'],
  AUTHORITY_REVIEW: ['QUALIFICATION', 'QUALIFIED', 'DECLINED', 'CLOSED'],
  // QUALIFIED -> CONVERTED exists in the matrix but is only reachable through the explicit conversion
  // action (Phase 3), never through the generic status endpoint (see GENERIC_ENDPOINT_BLOCKED).
  QUALIFIED: ['CONVERTED', 'DECLINED', 'CLOSED'],
  CONVERTED: [],
  DECLINED: [],
  CLOSED: [],
};
export const GENERIC_ENDPOINT_BLOCKED: readonly SellerStatus[] = ['CONVERTED'];
/** Moving to these needs a written reason and an explicit confirmation. */
export const REASON_REQUIRED: readonly SellerStatus[] = ['DECLINED', 'CLOSED'];
/** Moving to these is consequential and needs explicit confirmation. */
export const CONFIRM_REQUIRED: readonly SellerStatus[] = ['DECLINED', 'CLOSED', 'QUALIFIED', 'AUTHORITY_REVIEW'];

export const isStatus = (v: unknown): v is SellerStatus => typeof v === 'string' && (SELLER_STATUSES as readonly string[]).includes(v);
export const isTerminal = (s: SellerStatus): boolean => TERMINAL_STATUSES.includes(s);
export const allowedTransitions = (from: SellerStatus): readonly SellerStatus[] => TRANSITIONS[from];
export const canTransition = (from: SellerStatus, to: SellerStatus): boolean => TRANSITIONS[from].includes(to);
/** Transitions offered through the generic status endpoint. */
export const genericTransitions = (from: SellerStatus): SellerStatus[] => TRANSITIONS[from].filter((s) => !GENERIC_ENDPOINT_BLOCKED.includes(s));

export const QUALIFICATION_ITEMS = [
  'fit_with_scope', 'contact_role_and_identity', 'decision_maker_status', 'claimed_authority', 'authority_evidence_needed',
  'existing_adviser_relationships', 'potential_conflicts', 'asset_jurisdiction', 'confidentiality_requirements',
  'credibility_and_consistency', 'sale_timing',
] as const;
