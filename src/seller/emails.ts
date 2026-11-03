import { countryName } from './countries';
import type { SellerEnquiryForEmail } from './repo';
import type { FollowupForReminder } from './staff-repo';

export const TEMPLATE_ACK = 'seller_enquiry_received_v1';
export const TEMPLATE_ALERT = 'seller_enquiry_internal_alert_v1';
export const SELLER_DASHBOARD_PATH = '/dashboard/seller-enquiries/ui';
export const TEMPLATE_FOLLOWUP_DUE = 'seller_followup_due_v1';

export interface RenderedEmail {
  templateId: string;
  subject: string;
  html: string;
  text: string;
}
export interface SellerEmailConfig {
  companyWebsite: string;
  baseUrl: string;
  includePhone: boolean;
  includePrice: boolean;
}

export const escapeHtml = (value: unknown): string =>
  String(value ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);
/** Remove CR/LF and other control characters from anything placed in a header-like or single-line position. */
// eslint-disable-next-line no-control-regex
export const oneLine = (value: unknown): string => String(value ?? '').replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ').trim();
/** Staff-authenticated page; the reference is a selector, not a credential. */
export const dashboardUrl = (cfg: SellerEmailConfig, reference: string): string =>
  `${cfg.baseUrl.replace(/\/$/, '')}${SELLER_DASHBOARD_PATH}?selected=${encodeURIComponent(reference)}`;
const label = (v: string): string => v.toLowerCase().replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());

const BRAND_OPEN = '<div style="font-family:Georgia,serif;color:#292522;max-width:640px;margin:0 auto;line-height:1.6">';
const BRAND_CLOSE = '</div>';
const paragraphs = (items: string[]) => items.map((p) => `<p>${p}</p>`).join('');

export function renderSellerAcknowledgement(e: Pick<SellerEnquiryForEmail, 'contactName' | 'reference'>, cfg: SellerEmailConfig): RenderedEmail {
  const name = oneLine(e.contactName);
  const site = cfg.companyWebsite;
  const text = `Dear ${name},

Thank you for contacting Luminous Agents regarding your potential sale or investment opportunity.

Your enquiry has been received and recorded under reference:

${e.reference}

Our brokerage team will review the information you have provided and determine the appropriate next steps. If we require further information or clarification, a member of the team may contact you using your preferred contact method.

CONFIDENTIALITY

We understand that the potential sale of a casino, casino-hotel or related hospitality asset may require discretion. We will review your stated confidentiality preferences when assessing your enquiry.

Please do not send sensitive financial records, identity documents, ownership records or other confidential supporting documents in response to this automated email. If additional documentation is required, our team will explain the appropriate secure submission process.

IMPORTANT INFORMATION

Receipt of your enquiry does not constitute acceptance of an engagement, appointment as your broker, a mandate to market or sell an asset, or confirmation that Luminous Agents has verified your authority to act.

Any proposed engagement or marketing activity will be subject to further review and, where applicable, a separate written agreement.

Thank you for considering Luminous Agents.

Yours sincerely,

Brokerage Team
Luminous Agents

Confidential Casino & Casino-Hotel Brokerage

${site}

This is an automated acknowledgement of receipt. Please reply to this email only if your enquiry requires clarification; do not attach confidential documents.
`;
  const html =
    BRAND_OPEN +
    paragraphs([
      `Dear ${escapeHtml(name)},`,
      'Thank you for contacting Luminous Agents regarding your potential sale or investment opportunity.',
      `Your enquiry has been received and recorded under reference:<br><strong style="font-size:1.2em">${escapeHtml(e.reference)}</strong>`,
      'Our brokerage team will review the information you have provided and determine the appropriate next steps. If we require further information or clarification, a member of the team may contact you using your preferred contact method.',
      '<strong>CONFIDENTIALITY</strong>',
      'We understand that the potential sale of a casino, casino-hotel or related hospitality asset may require discretion. We will review your stated confidentiality preferences when assessing your enquiry.',
      'Please do not send sensitive financial records, identity documents, ownership records or other confidential supporting documents in response to this automated email. If additional documentation is required, our team will explain the appropriate secure submission process.',
      '<strong>IMPORTANT INFORMATION</strong>',
      'Receipt of your enquiry does not constitute acceptance of an engagement, appointment as your broker, a mandate to market or sell an asset, or confirmation that Luminous Agents has verified your authority to act.',
      'Any proposed engagement or marketing activity will be subject to further review and, where applicable, a separate written agreement.',
      'Thank you for considering Luminous Agents.',
      'Yours sincerely,<br><br>Brokerage Team<br>Luminous Agents',
      `<em>Confidential Casino &amp; Casino-Hotel Brokerage</em><br>${escapeHtml(site)}`,
      '<small>This is an automated acknowledgement of receipt. Please reply to this email only if your enquiry requires clarification; do not attach confidential documents.</small>',
    ]) +
    BRAND_CLOSE;
  return { templateId: TEMPLATE_ACK, subject: 'Luminous Agents — Enquiry Received', html, text };
}

const INTERNAL_NOTICE_1 =
  'This alert is for internal use only. Do not forward it outside the authorised brokerage team. Review the full enquiry through the authenticated dashboard rather than circulating seller information by email.';
const INTERNAL_NOTICE_2 =
  'The submission is an unqualified lead. It is not proof of ownership, authority to sell, an accepted mandate or permission to publish the opportunity.';
const NEXT_ACTIONS = ['Assign a broker owner.', 'Review confidentiality preference before any contact.', 'Attempt contact using the preferred method and record the outcome.', 'Begin qualification; authority is unverified.'];

export function renderSellerInternalAlert(e: SellerEnquiryForEmail, cfg: SellerEmailConfig): RenderedEmail {
  const url = dashboardUrl(cfg, e.reference);
  const rows: Array<[string, string]> = [
    ['Reference', e.reference],
    ['Received (UTC)', e.createdAt],
    ['Status', e.status],
    ['Contact', `${oneLine(e.contactName)} (${label(e.contactRole)})`],
    ['Organisation', oneLine(e.organisation) || 'Not provided'],
    ['Email', oneLine(e.email)],
    ...(cfg.includePhone ? ([['Telephone', oneLine(e.telephone) || 'Not provided']] as Array<[string, string]>) : []),
    ['Preferred contact method', label(e.preferredContactMethod)],
    ['Contact country', countryName(e.contactCountry)],
    ['Asset type', label(e.assetType)],
    ['Asset country', countryName(e.assetCountry)],
    ['Asset name', e.assetNameConfidential ? 'Withheld (marked confidential)' : oneLine(e.assetName) || 'Not provided'],
    ['Operating status', label(e.operatingStatus)],
    ['Sale timing', label(e.saleTiming)],
    ...(cfg.includePrice ? ([['Asking price (as stated)', e.askingPriceText ? `${oneLine(e.askingPriceText)} ${e.currency ?? ''}`.trim() : 'Not provided']] as Array<[string, string]>) : []),
    ['Confidentiality preference', label(e.confidentialityPreference)],
    ['Authority declaration (unverified)', e.authorityDeclaration],
    ['Consent recorded', `Privacy acknowledgement and accuracy declaration recorded; marketing consent: ${e.marketingConsent ? 'yes' : 'no'}`],
    ['Dashboard', url],
  ];
  const text = `New seller enquiry\n\n${rows.map(([k, v]) => `${k}: ${v}`).join('\n')}\n\nRecommended next actions:\n${NEXT_ACTIONS.map((a) => `- ${a}`).join('\n')}\n\n${INTERNAL_NOTICE_1}\n\n${INTERNAL_NOTICE_2}\n`;
  const html =
    BRAND_OPEN +
    '<h2>New seller enquiry</h2><table cellpadding="4" style="border-collapse:collapse">' +
    rows.map(([k, v]) => `<tr><td><strong>${escapeHtml(k)}</strong></td><td>${k === 'Dashboard' ? `<a href="${escapeHtml(v)}">${escapeHtml(v)}</a>` : escapeHtml(v)}</td></tr>`).join('') +
    '</table><p><strong>Recommended next actions</strong></p><ul>' +
    NEXT_ACTIONS.map((a) => `<li>${escapeHtml(a)}</li>`).join('') +
    `</ul><p>${escapeHtml(INTERNAL_NOTICE_1)}</p><p>${escapeHtml(INTERNAL_NOTICE_2)}</p>` +
    BRAND_CLOSE;
  return { templateId: TEMPLATE_ALERT, subject: `New Seller Enquiry — ${e.reference}`, html, text };
}

const REMINDER_MESSAGE = [
  'A seller enquiry requires follow-up.',
  'Review the enquiry history and determine the appropriate next step. Record the outcome of any contact attempt and update the next follow-up date.',
  'This is an internal reminder. Review confidentiality restrictions before contacting the seller or sharing any information.',
];

export function renderSellerFollowupDue(t: FollowupForReminder, cfg: SellerEmailConfig, escalated = false): RenderedEmail {
  const rows: Array<[string, string]> = [
    ['Enquiry reference', t.reference],
    ['Seller name', oneLine(t.contactName)],
    ['Current status', label(t.enquiryStatus)],
    ['Assigned broker', oneLine(t.assigneeName) || 'Unassigned'],
    ['Last contact', t.lastContactAt ?? 'No contact recorded'],
    ['Follow-up due', t.dueAt],
    ['Follow-up reason', oneLine(t.title)],
    ['Dashboard', dashboardUrl(cfg, t.reference)],
  ];
  const lead = escalated ? ['This follow-up is overdue and has been escalated.', ...REMINDER_MESSAGE] : REMINDER_MESSAGE;
  const text = `${lead.join('\n\n')}\n\n${rows.map(([k, v]) => `${k}: ${v}`).join('\n')}\n`;
  const html = BRAND_OPEN + lead.map((p) => `<p>${escapeHtml(p)}</p>`).join('') + '<table cellpadding="4">' +
    rows.map(([k, v]) => `<tr><td><strong>${escapeHtml(k)}</strong></td><td>${k === 'Dashboard' ? `<a href="${escapeHtml(v)}">${escapeHtml(v)}</a>` : escapeHtml(v)}</td></tr>`).join('') + '</table>' + BRAND_CLOSE;
  return { templateId: TEMPLATE_FOLLOWUP_DUE, subject: `${escalated ? 'Escalated: ' : ''}Seller Follow-up Due — ${t.reference}`, html, text };
}
