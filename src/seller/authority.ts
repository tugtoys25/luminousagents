/**
 * Authority and mandate model (pure; unit-tested). The five authority types are separate concepts: authority to
 * submit an enquiry, to represent the owner, to negotiate, to market the asset, and a valid brokerage mandate.
 * None implies another, and none is inferred from a role selection, an ownership claim or an uploaded document.
 */
export const AUTHORITY_TYPES = ['AUTHORITY_TO_SUBMIT', 'AUTHORITY_TO_REPRESENT', 'AUTHORITY_TO_NEGOTIATE', 'AUTHORITY_TO_MARKET', 'BROKERAGE_MANDATE'] as const;
export type AuthorityType = (typeof AUTHORITY_TYPES)[number];
export const AUTHORITY_STATUSES = ['NOT_REVIEWED', 'EVIDENCE_REQUESTED', 'UNDER_REVIEW', 'VERIFIED', 'REJECTED', 'EXPIRED', 'REVOKED', 'NOT_REQUIRED_WITH_RECORDED_REASON'] as const;
export type AuthorityStatus = (typeof AUTHORITY_STATUSES)[number];
export const EVIDENCE_TYPES = ['NONE', 'POWER_OF_ATTORNEY', 'BOARD_RESOLUTION', 'SIGNED_MANDATE', 'OWNERSHIP_RECORD', 'OTHER'] as const;

const T: Record<AuthorityStatus, readonly AuthorityStatus[]> = {
  NOT_REVIEWED: ['EVIDENCE_REQUESTED', 'UNDER_REVIEW', 'NOT_REQUIRED_WITH_RECORDED_REASON'],
  EVIDENCE_REQUESTED: ['UNDER_REVIEW', 'REJECTED'],
  UNDER_REVIEW: ['VERIFIED', 'REJECTED', 'EVIDENCE_REQUESTED'],
  VERIFIED: ['REVOKED', 'EXPIRED'],
  REJECTED: ['UNDER_REVIEW'],
  EXPIRED: ['UNDER_REVIEW'],
  REVOKED: [],
  NOT_REQUIRED_WITH_RECORDED_REASON: ['REVOKED'],
};
export const canAuthorityTransition = (from: AuthorityStatus, to: AuthorityStatus): boolean => T[from].includes(to);
export const authorityTransitions = (from: AuthorityStatus): readonly AuthorityStatus[] => T[from];
export const isAuthorityStatus = (v: unknown): v is AuthorityStatus => typeof v === 'string' && (AUTHORITY_STATUSES as readonly string[]).includes(v);

/** Moving to these statuses is an approval: it needs the approve permission (and separation of duties when enabled). */
export const APPROVAL_STATUSES: readonly AuthorityStatus[] = ['VERIFIED', 'NOT_REQUIRED_WITH_RECORDED_REASON', 'REVOKED', 'EXPIRED'];
/** Statuses that withdraw any live opportunity that depends on the record. */
export const WITHDRAWING_STATUSES: readonly AuthorityStatus[] = ['REVOKED', 'EXPIRED'];

export interface AuthorityView { authorityType: string; status: string; validFrom: string | null; validUntil: string | null }

/** A record only counts today if verified inside its validity window (or recorded as not required, with a reason). */
export function recordSatisfies(r: AuthorityView, nowIso: string): boolean {
  if (r.status === 'NOT_REQUIRED_WITH_RECORDED_REASON') return true;
  if (r.status !== 'VERIFIED') return false;
  if (r.validFrom && r.validFrom > nowIso) return false;
  if (r.validUntil && r.validUntil <= nowIso) return false;
  return true;
}

/** Evidence references point at items in private storage or the compliance system. URLs and free text are rejected. */
export const EVIDENCE_REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:#/-]{2,119}$/;
export const isSafeEvidenceRef = (v: string): boolean => EVIDENCE_REF_PATTERN.test(v) && !v.includes('://') && !v.includes('..');
