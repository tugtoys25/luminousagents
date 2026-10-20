/** Internal staff emails. Data-minimising: no seller name, contact details, description or price. */
import { countryName } from './countries';
import { dashboardUrl, escapeHtml, oneLine, type RenderedEmail, type SellerEmailConfig } from './emails';
import type { AssignmentNotice } from './staff-repo';

export const TEMPLATE_ASSIGNED = 'seller_enquiry_assigned_v1';
const label = (v: string): string => v.toLowerCase().replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
const NOTICE = 'This message is for internal use only. Review the enquiry through the authenticated dashboard and check confidentiality restrictions before contacting the seller. The submission is an unqualified lead: it is not proof of ownership, authority to sell, a mandate or permission to publish.';

export function renderSellerAssignment(n: AssignmentNotice, cfg: SellerEmailConfig): RenderedEmail {
  const rows: Array<[string, string]> = [
    ['Enquiry reference', n.reference], ['Status', label(n.status)], ['Asset type', label(n.assetType)], ['Asset country', countryName(n.assetCountry)],
    ['Confidentiality preference', label(n.confidentialityPreference)], ['Dashboard', dashboardUrl(cfg, n.reference)],
  ];
  const text = `Hello ${oneLine(n.assigneeName)},\n\nA seller enquiry has been assigned to you.\n\n${rows.map(([k, v]) => `${k}: ${v}`).join('\n')}\n\n${NOTICE}\n`;
  const html = '<div style="font-family:Georgia,serif;color:#292522;max-width:640px;margin:0 auto;line-height:1.6">' + `<p>Hello ${escapeHtml(oneLine(n.assigneeName))},</p><p>A seller enquiry has been assigned to you.</p><table cellpadding="4">` +
    rows.map(([k, v]) => `<tr><td><strong>${escapeHtml(k)}</strong></td><td>${k === 'Dashboard' ? `<a href="${escapeHtml(v)}">${escapeHtml(v)}</a>` : escapeHtml(v)}</td></tr>`).join('') + `</table><p>${escapeHtml(NOTICE)}</p></div>`;
  return { templateId: TEMPLATE_ASSIGNED, subject: `Seller Enquiry Assigned — ${n.reference}`, html, text };
}
