/* Seller enquiry form: conditional fields, counter, accessible errors, JSON submit. No submitted data is kept in URLs or storage. */
(() => {
  const form = document.getElementById('seller-form');
  if (!form) return;
  const summary = document.getElementById('seller-form-error');
  const success = document.getElementById('seller-success');
  const key = (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(36).slice(2)).replace(/[^A-Za-z0-9_-]/g, '') .padEnd(16, '0').slice(0, 64);
  const el = (name) => form.elements.namedItem(name);
  const wrap = (name) => form.querySelector('[data-field="' + name + '"]');

  const toggle = (name, show) => {
    const w = wrap(name);
    if (!w) return;
    w.hidden = !show;
    const input = el(name);
    if (input && 'required' in input) input.required = show;
    if (!show && input) input.value = '';
  };
  const sync = () => {
    toggle('contact_role_other', el('contact_role').value === 'OTHER');
    toggle('asset_type_other', el('asset_type').value === 'OTHER_RELATED_INVESTMENT');
    const priced = el('asking_price_text').value.trim() !== '';
    const cur = el('currency');
    cur.required = priced;
    toggle('currency_other', priced && cur.value === 'OTHER');
  };
  ['contact_role', 'asset_type', 'currency'].forEach((n) => el(n).addEventListener('change', sync));
  el('asking_price_text').addEventListener('input', sync);
  sync();

  const desc = el('asset_description');
  const count = document.getElementById('s-desc-count');
  desc.addEventListener('input', () => { count.textContent = desc.value.length + ' / ' + desc.maxLength + ' characters'; });

  const clearErrors = () => {
    summary.hidden = true;
    form.querySelectorAll('.field-error').forEach((p) => { p.hidden = true; p.textContent = ''; });
    form.querySelectorAll('[aria-invalid]').forEach((i) => i.removeAttribute('aria-invalid'));
  };
  const showFieldErrors = (fields) => {
    let first = null;
    Object.keys(fields).forEach((name) => {
      const w = wrap(name);
      if (!w) return;
      const p = w.querySelector('.field-error');
      if (p) { p.textContent = fields[name]; p.hidden = false; }
      const input = w.querySelector('input,select,textarea');
      if (input) { input.setAttribute('aria-invalid', 'true'); if (!first) first = input; }
    });
    return first;
  };
  const showSummary = (message) => { summary.textContent = message; summary.hidden = false; summary.focus(); };

  const payload = () => {
    const d = { idempotency_key: key };
    ['contact_name','contact_role','contact_role_other','email','telephone','organisation','preferred_contact_method','contact_country','asset_type','asset_type_other','asset_country','asset_name','asset_description','operating_status','sale_reason','sale_timing','asking_price_text','currency','currency_other','additional_information','website'].forEach((n) => { const e = el(n); if (e) d[n] = e.value; });
    ['asset_name_confidential','authority_declaration','confidentiality_preference'].forEach((n) => { const checked = form.querySelector('input[name="' + n + '"]:checked'); d[n] = checked ? checked.value : ''; });
    ['privacy_acknowledged','accuracy_declared','marketing_consent'].forEach((n) => { const e = el(n); if (e) d[n] = e.checked; });
    const t = form.querySelector('[name="cf-turnstile-response"]');
    if (t) d['cf-turnstile-response'] = t.value;
    return d;
  };

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    clearErrors();
    const button = form.querySelector('button[type="submit"]');
    button.disabled = true; button.setAttribute('aria-busy', 'true');
    try {
      const res = await fetch(form.action, { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin', body: JSON.stringify(payload()) });
      const body = await res.json().catch(() => ({}));
      if (res.status === 202 && body.data && body.data.reference) {
        const h = document.createElement('h2'); h.textContent = 'Thank You for Your Enquiry';
        const p1 = document.createElement('p'); p1.textContent = 'Thank you for contacting Luminous Agents. Your enquiry has been received and will be reviewed by our brokerage team. If further information is required, a member of the team may contact you.';
        const p2 = document.createElement('p'); p2.textContent = 'Your reference is ';
        const strong = document.createElement('strong'); strong.textContent = body.data.reference; p2.appendChild(strong); p2.append('.');
        const p3 = document.createElement('p'); p3.textContent = 'Submission does not create a brokerage mandate or guarantee that the opportunity will be accepted or marketed. Please do not send sensitive supporting documents in response to an automated email.';
        success.replaceChildren(h, p1, p2, p3);
        success.hidden = false; form.hidden = true; success.focus();
        return;
      }
      if (res.status === 202) { // honeypot response: no reference
        success.textContent = 'Thank you. Your enquiry has been received.'; success.hidden = false; form.hidden = true; success.focus(); return;
      }
      if (res.status === 422 && body.error && body.error.fields) {
        const first = showFieldErrors(body.error.fields);
        showSummary('Please correct the highlighted fields.');
        if (first) first.focus();
      } else if (res.status === 422 && body.error && body.error.code === 'CHALLENGE_FAILED') {
        showSummary('Please complete the security check and try again.');
      } else if (res.status === 429) {
        showSummary('Please wait a few minutes before sending another enquiry.');
      } else {
        showSummary('We could not submit your enquiry. Please try again later.');
      }
    } catch {
      showSummary('We could not submit your enquiry. Please check your connection and try again.');
    } finally {
      button.disabled = false; button.removeAttribute('aria-busy');
      if (window.mayfairResetTurnstile) window.mayfairResetTurnstile(form);
    }
  });
})();
