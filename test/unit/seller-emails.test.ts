import { describe, expect, it } from 'vitest';
import { renderSellerAcknowledgement, renderSellerInternalAlert, type SellerEmailConfig } from '../../src/seller/emails';
import type { SellerEnquiryForEmail } from '../../src/seller/repo';

const cfg: SellerEmailConfig = { baseUrl: 'https://example.test', companyWebsite: 'https://example.test', includePhone: false, includePrice: false };
const enquiry = (over: Partial<SellerEnquiryForEmail> = {}): SellerEnquiryForEmail => ({
  id: 'id1', reference: 'CM-S-ABC234', contactName: 'Jane <b>Owner</b>', contactRole: 'OWNER', email: 'jane@example.com',
  telephone: '+44 20 7946 0958', organisation: 'Acme & Co', preferredContactMethod: 'EITHER', contactCountry: 'GB', assetType: 'CASINO_HOTEL',
  assetCountry: 'MT', assetName: 'Secret Palace', assetNameConfidential: 1, operatingStatus: 'OPERATING', saleTiming: 'ASAP',
  askingPriceText: '€50m', currency: 'EUR', confidentialityPreference: 'DISCUSS_WITH_BROKER', authorityDeclaration: 'UNSURE',
  status: 'NEW', createdAt: '2026-10-18T10:00:00.000Z', marketingConsent: 0, ...over,
});

describe('seller acknowledgement', () => {
  it('has the approved subject, template id, reference and plain-text alternative', () => {
    const m = renderSellerAcknowledgement(enquiry(), cfg);
    expect(m.templateId).toBe('seller_enquiry_received_v1');
    expect(m.subject).toBe('Casinos of Mayfair — Enquiry Received');
    expect(m.text).toContain('CM-S-ABC234');
    expect(m.text).toContain('does not constitute acceptance of an engagement');
    expect(m.html).toContain('CM-S-ABC234');
  });
  it('escapes dynamic HTML and never includes description, price or asset name', () => {
    const m = renderSellerAcknowledgement(enquiry(), cfg);
    expect(m.html).not.toContain('<b>Owner</b>');
    expect(m.html).toContain('&lt;b&gt;Owner&lt;/b&gt;');
    expect(m.text + m.html).not.toMatch(/€50m|Secret Palace/);
  });
});

describe('seller internal alert', () => {
  it('is data-minimising by default and states the internal-use notice', () => {
    const m = renderSellerInternalAlert(enquiry(), cfg);
    expect(m.subject).toBe('New Seller Enquiry — CM-S-ABC234');
    expect(m.text).not.toContain('+44 20');
    expect(m.text).not.toContain('€50m');
    expect(m.text).not.toContain('Secret Palace');
    expect(m.text).toContain('Withheld (marked confidential)');
    expect(m.text).toContain('unqualified lead');
    expect(m.text).toContain('https://example.test/dashboard');
    expect(m.text).not.toMatch(/token=/);
  });
  it('includes phone/price/asset name only when policy and consent flags allow', () => {
    const m = renderSellerInternalAlert(enquiry({ assetNameConfidential: 0 }), { ...cfg, includePhone: true, includePrice: true });
    expect(m.text).toContain('+44 20 7946 0958');
    expect(m.text).toContain('€50m EUR');
    expect(m.text).toContain('Secret Palace');
  });
  it('escapes HTML and renders missing optionals safely', () => {
    const m = renderSellerInternalAlert(enquiry({ organisation: null, assetName: null, assetNameConfidential: 0, contactName: '<img src=x onerror=1>' }), cfg);
    expect(m.html).not.toContain('<img');
    expect(m.text).toContain('Not provided');
  });
  it('collapses CR/LF so values cannot inject lines', () => {
    const m = renderSellerInternalAlert(enquiry({ contactName: 'A\r\nBcc: x@y.z' }), cfg);
    expect(m.text).not.toMatch(/\r|Contact: A\nBcc/);
  });
});
