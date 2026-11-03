import { Hono } from 'hono';
import { BaseLayout } from '../layouts/base';
import { COUNTRIES } from '../../seller/countries';
import { loadSellerPolicy } from '../../seller/policy-load';
import {
  ACCURACY_DECLARATION_TEXT,
  MARKETING_CONSENT_TEXT,
  PRIVACY_ACK_TEXT,
} from '../../seller/schema';
import type { PublicApp } from './public-shared';
import { SITE_URL } from './public-shared';

const ROLES: Array<[string, string]> = [
  ['OWNER', 'Owner'],
  ['DIRECTOR_EXECUTIVE', 'Director or executive'],
  ['AUTHORISED_REPRESENTATIVE', 'Authorised representative'],
  ['BROKER_INTERMEDIARY', 'Broker or intermediary'],
  ['PROFESSIONAL_ADVISER', 'Professional adviser'],
  ['OTHER', 'Other'],
];
const METHODS: Array<[string, string]> = [['EMAIL', 'Email'], ['TELEPHONE', 'Telephone'], ['EITHER', 'Either']];
const ASSET_TYPES: Array<[string, string]> = [
  ['CASINO', 'Casino'],
  ['CASINO_HOTEL', 'Casino-hotel'],
  ['HOTEL_RESORT_WITH_CASINO', 'Hotel or resort with casino'],
  ['OPERATING_COMPANY', 'Operating company'],
  ['RELATED_PROPERTY_HOSPITALITY_ASSET', 'Related property or hospitality asset'],
  ['OTHER_RELATED_INVESTMENT', 'Other related investment'],
];
const STATUSES: Array<[string, string]> = [
  ['OPERATING', 'Operating'],
  ['TEMPORARILY_CLOSED', 'Temporarily closed'],
  ['UNDER_DEVELOPMENT', 'Under development'],
  ['NOT_YET_OPERATING', 'Not yet operating'],
  ['DISCUSS_PRIVATELY', 'Prefer to discuss privately'],
];
const REASONS: Array<[string, string]> = [
  ['STRATEGIC_DECISION', 'Strategic decision'],
  ['OWNERSHIP_CHANGE_SUCCESSION', 'Ownership change or succession'],
  ['PORTFOLIO_RESTRUCTURING', 'Portfolio restructuring'],
  ['INVESTMENT_REALISATION', 'Investment realisation'],
  ['OTHER', 'Other'],
  ['DISCUSS_PRIVATELY', 'Prefer to discuss privately'],
];
const TIMINGS: Array<[string, string]> = [
  ['ASAP', 'As soon as possible'],
  ['WITHIN_3_MONTHS', 'Within 3 months'],
  ['WITHIN_6_MONTHS', 'Within 6 months'],
  ['WITHIN_12_MONTHS', 'Within 12 months'],
  ['OVER_12_MONTHS', 'Over 12 months'],
  ['EXPLORING', 'Exploring options'],
];
const CURRENCIES = ['GBP', 'EUR', 'USD', 'CHF', 'AED', 'OTHER'];
const CONFIDENTIALITY: Array<[string, string]> = [
  ['CONTACT_BEFORE_PUBLIC_IDENTIFICATION', 'Contact me before any public identification of the asset'],
  ['DISCUSS_PUBLIC_LISTING_AFTER_REVIEW', 'Discuss a public listing after review'],
  ['DISCUSS_WITH_BROKER', 'I would like to discuss this with a broker'],
];

const Select = (p: { id: string; name: string; label: string; options: Array<[string, string]>; required?: boolean; autoComplete?: string; placeholder?: string }) => (
  <div class="field" data-field={p.name}>
    <label for={p.id}>{p.label}{p.required ? <span aria-hidden="true"> *</span> : null}</label>
    <select id={p.id} name={p.name} required={p.required} autoComplete={p.autoComplete} aria-describedby={`${p.id}-error`}>
      <option value="">{p.placeholder ?? 'Select…'}</option>
      {p.options.map(([value, text]) => (<option value={value}>{text}</option>))}
    </select>
    <p class="field-error" id={`${p.id}-error`} hidden></p>
  </div>
);
const Input = (p: { id: string; name: string; label: string; required?: boolean; type?: string; max: number; min?: number; autoComplete?: string; hint?: string; hidden?: boolean }) => (
  <div class="field" data-field={p.name} data-conditional={p.hidden ? 'true' : undefined} hidden={p.hidden}>
    <label for={p.id}>{p.label}{p.required ? <span aria-hidden="true"> *</span> : null}</label>
    <input id={p.id} name={p.name} type={p.type ?? 'text'} required={p.required} maxLength={p.max} minLength={p.min} autoComplete={p.autoComplete ?? 'off'} aria-describedby={`${p.id}-error`} />
    {p.hint ? <p class="field-hint">{p.hint}</p> : null}
    <p class="field-error" id={`${p.id}-error`} hidden></p>
  </div>
);
const Radios = (p: { name: string; legend: string; options: Array<[string, string]> }) => (
  <fieldset class="field" data-field={p.name} aria-describedby={`${p.name}-error`}>
    <legend>{p.legend}<span aria-hidden="true"> *</span></legend>
    {p.options.map(([value, text], i) => (
      <label class="choice"><input type="radio" name={p.name} value={value} required={i === 0} /> {text}</label>
    ))}
    <p class="field-error" id={`${p.name}-error`} hidden></p>
  </fieldset>
);

const publicSell = new Hono<PublicApp>();

publicSell.get('/sell-a-casino', async (c) => {
  const marketing = (await loadSellerPolicy(c.env)).marketingConsentEnabled;
  const countries = COUNTRIES.map(([code, name]) => [code, name] as [string, string]);
  return c.html(
    <BaseLayout
      siteUrl={c.env.PUBLIC_BASE_URL || SITE_URL}
      contact={c.get('contact')}
      content={c.get('content')}
      title="Sell a Casino or Casino-Hotel | Luminous Agents"
      description="Confidential enquiries from owners and authorised representatives of casinos, casino-hotels and related hospitality assets."
      canonicalPath="/sell-a-casino"
    >
      <section class="page-hero">
        <div class="container">
          <span class="eyebrow">CONFIDENTIAL BROKERAGE</span>
          <h1>Considering Selling a Casino or Casino-Hotel?</h1>
          <p>Luminous Agents works with owners and authorised representatives of casinos, casino-hotels and related hospitality assets. Tell us a little about the opportunity, and our brokerage team will review your enquiry and contact you to discuss the next steps.</p>
          <p>If your proposed sale is confidential, you can indicate this below. Please do not submit sensitive documents or confidential financial information at this initial stage.</p>
        </div>
      </section>
      <section class="section">
        <div class="container">
          <p class="form-privacy">Initial enquiries are handled discreetly. Please review our <a href="/legal/privacy">Privacy Notice</a> to understand how we process the personal information you provide. Submission of this form does not create a brokerage mandate or guarantee that an opportunity will be accepted or marketed.</p>
          <noscript><div class="form-error" role="alert">JavaScript is required to submit this form securely. Please enable it or contact us directly.</div></noscript>
          <div id="seller-success" class="form-notice" role="status" tabIndex={-1} hidden></div>
          <form class="contact-form seller-form" id="seller-form" method="post" action="/api/sell-a-casino" data-turnstile novalidate>
            <div id="seller-form-error" class="form-error" role="alert" tabIndex={-1} hidden></div>
            <h2>Contact details</h2>
            <Input id="s-name" name="contact_name" label="Full name" required max={120} min={2} autoComplete="name" />
            <Select id="s-role" name="contact_role" label="Role in relation to the opportunity" options={ROLES} required />
            <Input id="s-role-other" name="contact_role_other" label="Describe your role" required max={120} min={3} hidden />
            <Input id="s-email" name="email" type="email" label="Business email" required max={254} autoComplete="email" />
            <Input id="s-phone" name="telephone" type="tel" label="Telephone" max={40} autoComplete="tel" />
            <Input id="s-org" name="organisation" label="Company or organisation" max={160} autoComplete="organization" />
            <Select id="s-method" name="preferred_contact_method" label="Preferred contact method" options={METHODS} required />
            <Select id="s-ccountry" name="contact_country" label="Country of residence or business" options={countries} required autoComplete="country" />
            <h2>Asset details</h2>
            <Select id="s-atype" name="asset_type" label="Asset type" options={ASSET_TYPES} required />
            <Input id="s-atype-other" name="asset_type_other" label="Describe the asset type" required max={120} min={3} hidden />
            <Select id="s-acountry" name="asset_country" label="Asset country" options={countries} required />
            <Input id="s-aname" name="asset_name" label="Asset name" max={160} />
            <Radios name="asset_name_confidential" legend="Keep the asset name confidential?" options={[['YES', 'Yes'], ['NO', 'No']]} />
            <div class="field" data-field="asset_description">
              <label for="s-desc">Short asset description <span aria-hidden="true">*</span></label>
              <textarea id="s-desc" name="asset_description" required minLength={30} maxLength={2000} rows={6} aria-describedby="s-desc-hint s-desc-count s-desc-error"></textarea>
              <p class="field-hint" id="s-desc-hint">Please do not include confidential financial information, identity information or sensitive documents.</p>
              <p class="field-hint" id="s-desc-count" aria-live="polite">0 / 2000 characters</p>
              <p class="field-error" id="s-desc-error" hidden></p>
            </div>
            <Select id="s-status" name="operating_status" label="Operating status" options={STATUSES} required />
            <Radios name="authority_declaration" legend="Are you authorised to submit this enquiry?" options={[['YES', 'Yes'], ['NO', 'No'], ['UNSURE', 'Unsure']]} />
            <h2>Sale and transaction context</h2>
            <Select id="s-reason" name="sale_reason" label="Reason for sale" options={REASONS} />
            <Select id="s-timing" name="sale_timing" label="Expected sale timing" options={TIMINGS} required />
            <Input id="s-price" name="asking_price_text" label="Asking price" max={100} hint="Optional. Enter it as you would state it; we do not treat it as verified." />
            <Select id="s-currency" name="currency" label="Currency" options={CURRENCIES.map((x) => [x, x] as [string, string])} />
            <Input id="s-currency-other" name="currency_other" label="Other currency" max={20} hidden />
            <div class="field" data-field="additional_information">
              <label for="s-extra">Additional information</label>
              <textarea id="s-extra" name="additional_information" maxLength={2000} rows={4} aria-describedby="s-extra-error"></textarea>
              <p class="field-error" id="s-extra-error" hidden></p>
            </div>
            <h2>Confidentiality and declarations</h2>
            <Radios name="confidentiality_preference" legend="Confidentiality preference" options={CONFIDENTIALITY} />
            <div class="field" data-field="privacy_acknowledged">
              <label class="consent-label"><input type="checkbox" name="privacy_acknowledged" required aria-describedby="privacy_acknowledged-error" /> <span>{PRIVACY_ACK_TEXT} <span aria-hidden="true">*</span></span></label>
              <p class="field-error" id="privacy_acknowledged-error" hidden></p>
            </div>
            <div class="field" data-field="accuracy_declared">
              <label class="consent-label"><input type="checkbox" name="accuracy_declared" required aria-describedby="accuracy_declared-error" /> <span>{ACCURACY_DECLARATION_TEXT} <span aria-hidden="true">*</span></span></label>
              <p class="field-error" id="accuracy_declared-error" hidden></p>
            </div>
            {marketing ? (
              <div class="field" data-field="marketing_consent">
                <label class="consent-label"><input type="checkbox" name="marketing_consent" /> <span>{MARKETING_CONSENT_TEXT}</span></label>
              </div>
            ) : null}
            <div class="honeypot" aria-hidden="true">
              <label for="s-website">Leave this field empty</label>
              <input id="s-website" name="website" tabIndex={-1} autoComplete="off" />
            </div>
            <button class="button button-primary" type="submit">Submit Confidential Enquiry</button>
          </form>
          <script src="/static/js/turnstile-forms.js" defer></script>
          <script src="/static/js/sell-form.js" defer></script>
        </div>
      </section>
    </BaseLayout>,
  );
});

export default publicSell;
