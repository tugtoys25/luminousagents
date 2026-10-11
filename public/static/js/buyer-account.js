(() => {
  const $ = (selector) => document.querySelector(selector);
  const notice = $('#account-notice');
  const signIn = $('#sign-in');
  const content = $('#buyer-content');
  let requestedOpportunityId = new URLSearchParams(window.location.search).get('opportunity') || '';
  let activeNdaTemplateId = '';
  const esc = (value) =>
    String(value ?? '').replace(
      /[&<>"']/g,
      (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
    );
  async function api(url, options = {}) {
    const response = await fetch(url, {
      credentials: 'same-origin',
      ...options,
      headers: {
        ...(options.body && !(options.body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}),
        ...(options.headers || {}),
      },
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      if (payload.error?.code === 'PASSWORD_CHANGE_REQUIRED')
        window.location.assign('/account/change-password');
      throw new Error(payload.error?.message || 'Request failed.');
    }
    return payload.data;
  }
  async function loadProfile() {
    const form = $('#buyer-profile-form');
    if (!form) return;
    const status = $('#buyer-profile-notice');
    try {
      const profile = await api('/api/buyer/profile');
      for (const key of ['companyName', 'roleTitle', 'budgetMin', 'budgetMax', 'currency', 'experienceNotes']) {
        form.elements.namedItem(key).value = profile[key] ?? '';
      }
      form.elements.namedItem('countries').value = (profile.countries || []).join(', ');
    } catch (error) {
      status.textContent = error.message || 'Could not load your profile.';
    }
  }
  const profileForm = $('#buyer-profile-form');
  if (profileForm) profileForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const status = $('#buyer-profile-notice');
    const data = new FormData(profileForm);
    const numeric = (key) => String(data.get(key) || '').trim() === '' ? null : Number(data.get(key));
    const payload = {
      companyName: String(data.get('companyName') || '').trim(),
      roleTitle: String(data.get('roleTitle') || '').trim(),
      countries: String(data.get('countries') || '').split(',').map((value) => value.trim()).filter(Boolean),
      budgetMin: numeric('budgetMin'),
      budgetMax: numeric('budgetMax'),
      currency: String(data.get('currency') || 'GBP'),
      experienceNotes: String(data.get('experienceNotes') || '').trim(),
    };
    status.textContent = 'Saving…';
    try {
      const profile = await api('/api/buyer/profile', { method: 'PUT', body: JSON.stringify(payload) });
      profileForm.elements.namedItem('countries').value = (profile.countries || []).join(', ');
      status.textContent = 'Profile saved.';
    } catch (error) {
      status.textContent = error.message || 'Could not save your profile.';
    }
  });

  async function loadAccount() {
    try {
      const buyer = await api('/api/buyer/me');
      signIn.hidden = true;
      content.hidden = false;
      $('#buyer-identity').textContent = `Signed in as ${buyer.displayName || buyer.email}`;
      document.querySelector('#buyer-password-choice')?.remove();
      await loadProfile();
      if (!buyer.hasPassword) { const choice = document.createElement('p'); choice.id = 'buyer-password-choice'; choice.className = 'muted'; choice.textContent = 'You signed in with an email code. You can set a password later or continue signing in with email codes.'; $('#buyer-identity').after(choice); }
      const ndaPanel = $('#nda-request-panel');
      ndaPanel.hidden = !requestedOpportunityId;
      if (requestedOpportunityId) {
        try {
          const template = await api('/api/buyer/nda-template');
          activeNdaTemplateId = template.id;
          $('#nda-template-content').textContent = template.content;
          $('#nda-template-version').textContent =
            `Template version ${template.version} · SHA-256 ${template.contentHash}`;
        } catch (error) {
          $('#nda-template-content').textContent = error.message;
          $('#nda-request-form').hidden = true;
        }
        $('#nda-request-form').onsubmit = async (event) => {
          event.preventDefault();
          const formData = new FormData(event.currentTarget);
          const acceptanceName = String(formData.get('acceptanceName') || '').trim();
          try {
            await api(
              `/api/buyer/opportunities/${encodeURIComponent(requestedOpportunityId)}/nda-requests`,
              {
                method: 'POST',
                body: JSON.stringify({ acceptanceName, templateId: activeNdaTemplateId }),
              },
            );
            notice.textContent = 'Your NDA request has been submitted for review.';
            requestedOpportunityId = '';
            ndaPanel.hidden = true;
            await loadAccount();
          } catch (error) {
            notice.textContent = error.message;
          }
        };
      }
      const [saved, ndas] = await Promise.all([
        api('/api/buyer/opportunities'),
        api('/api/buyer/nda-requests'),
      ]);
      $('#saved-list').innerHTML = saved.length
        ? saved
            .map(
              (o) =>
                `<div class="item"><h3><a href="/opportunities/${encodeURIComponent(o.slug)}">${esc(o.title)}</a></h3><p>${esc(o.country || 'Location on request')}</p></div>`,
            )
            .join('')
        : '<p>No saved opportunities yet. Save opportunities while browsing the public directory.</p>';
      $('#nda-list').innerHTML = ndas.length
        ? ndas
            .map(
              (n) =>
                `<div class="item"><h3>${esc(n.opportunityTitle)}</h3><p>Status: <strong>${esc(n.status)}</strong></p>${n.reviewReason ? `<p>${esc(n.reviewReason)}</p>` : ''}${n.status === 'pending' ? (n.hasSignedPdf ? '<p>Signed NDA PDF uploaded and security-scanned.</p>' : `<form data-signed-nda="${esc(n.id)}"><label>Upload signed NDA PDF (optional)<br><input type="file" name="file" accept="application/pdf" required></label><button type="submit">Upload signed PDF</button><p class="notice" role="status"></p></form>`) : ''}${n.accessExpiresAt ? `<p>Access expiry: ${esc(n.accessExpiresAt)}${n.accessRevokedAt ? ' (revoked)' : ''}</p>` : ''}${n.status === 'approved' && n.grantId && !n.accessRevokedAt ? `<button type="button" data-docs="${esc(n.opportunityId)}">View authorised documents</button><div id="docs-${esc(n.opportunityId)}"></div>` : ''}</div>`,
            )
            .join('')
        : '<p>No NDA requests yet.</p>';
      $('#nda-list').querySelectorAll('form[data-signed-nda]').forEach((form) => form.addEventListener('submit', async (event) => {
        event.preventDefault();
        const status = form.querySelector('[role="status"]');
        const button = form.querySelector('button[type="submit"]');
        const file = form.elements.namedItem('file').files?.[0];
        if (!file) { status.textContent = 'Choose a PDF first.'; return; }
        const body = new FormData(); body.append('file', file);
        button.disabled = true; status.textContent = 'Uploading and scanning PDF…';
        try {
          await api(`/api/buyer/nda-requests/${encodeURIComponent(form.dataset.signedNda)}/signed-pdf`, { method: 'POST', body });
          status.textContent = 'Signed NDA PDF uploaded and passed the security scan.';
          await loadAccount();
        } catch (error) { status.textContent = error.message || 'Could not upload the signed PDF.'; button.disabled = false; }
      }));
      $('#nda-list')
        .querySelectorAll('[data-docs]')
        .forEach((button) =>
          button.addEventListener('click', async () => {
            const target = $(`#docs-${CSS.escape(button.dataset.docs)}`);
            button.disabled = true;
            target.textContent = 'Loading documents…';
            try {
              const docs = await api(
                `/api/buyer/opportunities/${encodeURIComponent(button.dataset.docs)}/documents`,
              );
              target.innerHTML = docs.length
                ? docs
                    .map(
                      (d) =>
                        `<p>${esc(d.filename)} · ${(Number(d.byteSize) / 1024 / 1024).toFixed(2)} MB · <a href="/api/buyer/documents/${encodeURIComponent(d.id)}/download">Download</a></p>`,
                    )
                    .join('')
                : '<p>No documents are available for your access tier.</p>';
            } catch (error) {
              target.textContent = error.message;
            } finally {
              button.disabled = false;
            }
          }),
        );
    } catch {
      signIn.hidden = false;
      content.hidden = true;
    }
  }
  $('#sign-out').addEventListener('click', async () => {
    try {
      await api('/api/buyer/auth/logout', { method: 'POST', body: JSON.stringify({}) });
    } finally {
      content.hidden = true;
      signIn.hidden = false;
      notice.textContent = 'You have signed out.';
    }
  });
  loadAccount();
})();
