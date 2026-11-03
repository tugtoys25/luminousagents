/** Staff-sent seller emails. Content is rendered once at draft time, shown for approval, then frozen and hashed. */
import { escapeHtml, oneLine, type RenderedEmail } from './emails';

export const TEMPLATE_FOLLOWUP = 'seller_enquiry_followup_v1';
export const TEMPLATE_MATERIAL_INTEREST = 'seller_material_interest_v1';

export interface BrokerIdentity { name: string; title: string; email: string; telephone: string | null; website: string }

const BRAND_OPEN = '<div style="font-family:Georgia,serif;color:#292522;max-width:640px;margin:0 auto;line-height:1.6">';
const p = (s: string) => `<p>${s}</p>`;
const signatureText = (b: BrokerIdentity, withWebsite: boolean): string =>
  [oneLine(b.name), oneLine(b.title), 'Luminous Agents', '', oneLine(b.email), ...(b.telephone ? [oneLine(b.telephone)] : []), ...(withWebsite ? [b.website] : [])].join('\n');
const signatureHtml = (b: BrokerIdentity, withWebsite: boolean): string =>
  [escapeHtml(oneLine(b.name)), escapeHtml(oneLine(b.title)), 'Luminous Agents', '', escapeHtml(oneLine(b.email)), ...(b.telephone ? [escapeHtml(oneLine(b.telephone))] : []), ...(withWebsite ? [escapeHtml(b.website)] : [])].join('<br>');

const DISCUSS = [
  'Your role in relation to the asset and the ownership or decision-making structure.',
  'The proposed transaction and your anticipated timing.',
  "The asset's current operating status and principal characteristics.",
  'Any confidentiality requirements or restrictions on disclosure.',
  'Whether you already have an adviser, intermediary or existing brokerage arrangement.',
  'The appropriate next steps for reviewing your authority to act and any proposed engagement.',
];

/** The broker selects the questions; they are reviewed in the preview before anything is sent. */
export function renderSellerFollowup(i: { contactName: string; reference: string; questions: string[]; broker: BrokerIdentity }): RenderedEmail {
  const name = oneLine(i.contactName);
  const qs = i.questions.map((q) => oneLine(q));
  const text = `Dear ${name},

Thank you for contacting Luminous Agents regarding your potential sale or investment opportunity.

Our brokerage team has reviewed your initial enquiry and would welcome the opportunity to understand the circumstances and objectives behind the proposed transaction in more detail.

To help us assess whether we may be able to assist, we would appreciate clarification on the following points, where you are comfortable providing it:

${qs.map((q, n) => `${n + 1}. ${q}`).join('\n')}

Depending on the nature of the opportunity, it may also be helpful to discuss:

${DISCUSS.map((d) => `- ${d}`).join('\n')}

We recognise that some of this information may be commercially sensitive. Please do not send sensitive supporting documents or detailed confidential financial records by ordinary email. If documentation is required, we will discuss an appropriate method for providing it securely.

If you would prefer an initial conversation, please let us know your availability and preferred contact method.

We will review the information provided and advise you of any appropriate next steps. We cannot guarantee that the opportunity will be accepted, marketed or result in a transaction.

For reference, your enquiry number is ${i.reference}.

Yours sincerely,

${signatureText(i.broker, true)}

CONFIDENTIALITY

Please let us know if your confidentiality requirements change or if there are restrictions on how information about the opportunity may be discussed or disclosed.

No brokerage appointment or marketing authority is created by this correspondence. Any engagement will be subject to the necessary reviews and a separate written agreement, where applicable.
`;
  const html = BRAND_OPEN + [
    `Dear ${escapeHtml(name)},`,
    'Thank you for contacting Luminous Agents regarding your potential sale or investment opportunity.',
    'Our brokerage team has reviewed your initial enquiry and would welcome the opportunity to understand the circumstances and objectives behind the proposed transaction in more detail.',
    'To help us assess whether we may be able to assist, we would appreciate clarification on the following points, where you are comfortable providing it:',
  ].map(p).join('') + `<ol>${qs.map((q) => `<li>${escapeHtml(q)}</li>`).join('')}</ol>` + p('Depending on the nature of the opportunity, it may also be helpful to discuss:') +
    `<ul>${DISCUSS.map((d) => `<li>${escapeHtml(d)}</li>`).join('')}</ul>` + [
    'We recognise that some of this information may be commercially sensitive. Please do not send sensitive supporting documents or detailed confidential financial records by ordinary email. If documentation is required, we will discuss an appropriate method for providing it securely.',
    'If you would prefer an initial conversation, please let us know your availability and preferred contact method.',
    'We will review the information provided and advise you of any appropriate next steps. We cannot guarantee that the opportunity will be accepted, marketed or result in a transaction.',
    `For reference, your enquiry number is ${escapeHtml(i.reference)}.`,
    `Yours sincerely,<br><br>${signatureHtml(i.broker, true)}`,
    '<strong>CONFIDENTIALITY</strong>',
    'Please let us know if your confidentiality requirements change or if there are restrictions on how information about the opportunity may be discussed or disclosed.',
    'No brokerage appointment or marketing authority is created by this correspondence. Any engagement will be subject to the necessary reviews and a separate written agreement, where applicable.',
  ].map(p).join('') + '</div>';
  return { templateId: TEMPLATE_FOLLOWUP, subject: `Luminous Agents — Follow-up to Your Enquiry ${i.reference}`, html, text };
}

export interface InterestEmailInput { contactName: string; assetReference: string; interestType: string; interestStage: string; approvedSummary: string; proposedNextStep: string; broker: BrokerIdentity }
const label = (v: string): string => v.toLowerCase().replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());

/** Never includes the buyer's identity, terms or any field other than the approved ones. */
export function renderSellerMaterialInterest(i: InterestEmailInput): RenderedEmail {
  const name = oneLine(i.contactName);
  const asset = oneLine(i.assetReference);
  const type = label(i.interestType);
  const stage = oneLine(i.interestStage);
  const summary = i.approvedSummary.trim();
  const next = oneLine(i.proposedNextStep);
  const text = `Dear ${name},

I am writing to provide a confidential update regarding ${asset}.

Following our recent discussions and the work undertaken in connection with the opportunity, we have received an indication of interest from a potential buyer or investor that we consider appropriate to bring to your attention.

At this stage, the position is as follows:

Nature of interest: ${type}
Current stage: ${stage}
Summary: ${summary}
Proposed next step: ${next}

This update is provided to keep you informed of a potentially relevant development. The indication of interest remains subject to its stated terms, any applicable confidentiality restrictions and further assessment.

Unless expressly confirmed otherwise in a separate written communication, this development should not be treated as a formal offer, a binding commitment, evidence of available funding, completion certainty or a guarantee that a transaction will proceed.

We will continue to handle communications in accordance with the applicable confidentiality arrangements and the scope of our engagement. We will discuss any proposed disclosure of further information or any material next step with you as appropriate.

Please let me know if you would like to discuss this development or the proposed next steps.

Yours sincerely,

${signatureText(i.broker, false)}

CONFIDENTIAL — FOR THE INTENDED RECIPIENT ONLY

This message may contain commercially sensitive information relating to a potential transaction. Please do not forward or disclose it without first confirming that doing so is appropriate under the applicable confidentiality arrangements.

All further action remains subject to the relevant parties' approvals, applicable agreements and due diligence.
`;
  const html = BRAND_OPEN + [
    `Dear ${escapeHtml(name)},`,
    `I am writing to provide a confidential update regarding ${escapeHtml(asset)}.`,
    'Following our recent discussions and the work undertaken in connection with the opportunity, we have received an indication of interest from a potential buyer or investor that we consider appropriate to bring to your attention.',
    'At this stage, the position is as follows:',
    `<strong>Nature of interest:</strong> ${escapeHtml(type)}<br><strong>Current stage:</strong> ${escapeHtml(stage)}<br><strong>Summary:</strong> ${escapeHtml(summary).replace(/\n/g, '<br>')}<br><strong>Proposed next step:</strong> ${escapeHtml(next)}`,
    'This update is provided to keep you informed of a potentially relevant development. The indication of interest remains subject to its stated terms, any applicable confidentiality restrictions and further assessment.',
    'Unless expressly confirmed otherwise in a separate written communication, this development should not be treated as a formal offer, a binding commitment, evidence of available funding, completion certainty or a guarantee that a transaction will proceed.',
    'We will continue to handle communications in accordance with the applicable confidentiality arrangements and the scope of our engagement. We will discuss any proposed disclosure of further information or any material next step with you as appropriate.',
    'Please let me know if you would like to discuss this development or the proposed next steps.',
    `Yours sincerely,<br><br>${signatureHtml(i.broker, false)}`,
    '<strong>CONFIDENTIAL — FOR THE INTENDED RECIPIENT ONLY</strong>',
    'This message may contain commercially sensitive information relating to a potential transaction. Please do not forward or disclose it without first confirming that doing so is appropriate under the applicable confidentiality arrangements.',
    'All further action remains subject to the relevant parties&#39; approvals, applicable agreements and due diligence.',
  ].map(p).join('') + '</div>';
  return { templateId: TEMPLATE_MATERIAL_INTEREST, subject: `Confidential Update Regarding ${asset}`, html, text };
}

/** SHA-256 over the exact approved content; recomputed at dispatch to prove it was not altered after approval. */
export async function contentHash(m: { subject: string; text: string; html: string; recipient: string }): Promise<string> {
  const data = new TextEncoder().encode(JSON.stringify([m.recipient.toLowerCase(), m.subject, m.text, m.html]));
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', data)), (b) => b.toString(16).padStart(2, '0')).join('');
}
