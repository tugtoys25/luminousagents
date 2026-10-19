/** Publication gates for seller-sourced opportunities (pure). Mirrors the database trigger in migration 0037. */
import { recordSatisfies, type AuthorityView } from './authority';

export interface GateLink {
  sellerReference: string;
  relationshipStatus: string;
  reviewStatus: string;
  records: AuthorityView[];
}
export interface GateReview {
  status: string;
  scopeConfirmed: number; confidentialityReviewed: number; publicFieldsApproved: number;
  sensitiveDataReviewed: number; imageRightsChecked: number; legalReviewCompleted: number;
}
export interface GateInput { links: GateLink[]; review: GateReview | null }
export interface GateResult { applicable: boolean; unmet: string[] }

export function evaluatePublicationGates(input: GateInput, nowIso: string): GateResult {
  // An opportunity that was never linked to a seller is not seller-sourced: existing behaviour is unchanged.
  if (input.links.length === 0) return { applicable: false, unmet: [] };
  const unmet: string[] = [];
  const active = input.links.filter((l) => l.relationshipStatus === 'ACTIVE');
  if (active.length === 0) unmet.push('No active seller relationship is recorded for this opportunity.');
  for (const l of active) {
    const who = l.sellerReference;
    if (l.reviewStatus !== 'REVIEWED') unmet.push(`${who}: seller confidentiality restrictions have not been reviewed.`);
    if (!l.records.some((r) => r.authorityType === 'AUTHORITY_TO_MARKET' && recordSatisfies(r, nowIso)))
      unmet.push(`${who}: no currently valid verified authority to market the asset.`);
    if (!l.records.some((r) => r.authorityType === 'BROKERAGE_MANDATE' && recordSatisfies(r, nowIso)))
      unmet.push(`${who}: no currently valid brokerage mandate (or recorded reason that none is required).`);
  }
  const r = input.review;
  if (!r || r.status !== 'APPROVED') unmet.push('Publication review has not been approved.');
  else if (![r.scopeConfirmed, r.confidentialityReviewed, r.publicFieldsApproved, r.sensitiveDataReviewed, r.imageRightsChecked, r.legalReviewCompleted].every((v) => v === 1))
    unmet.push('Publication review is missing a required confirmation.');
  return { applicable: true, unmet };
}
