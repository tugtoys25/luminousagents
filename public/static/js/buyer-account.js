(() => {
  const $ = (selector) => document.querySelector(selector);
  const notice = $('#account-notice');
  const signIn = $('#sign-in');
  const content = $('#buyer-content');
  let email = '';
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
        ...(options.body ? { 'Content-Type': 'application/json' } : {}),
        ...(options.headers || {}),
      },
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error?.message || 'Request failed.');
    return payload.data;
  }
  async function loadAccount() {
    try {
      const buyer = await api('/api/buyer/me');
      email = buyer.email;
      signIn.hidden = true;
      content.hidden = false;
      $('#buyer-identity').textContent = `Signed in as ${buyer.displayName || buyer.email}`;
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
                `<div class="item"><h3>${esc(n.opportunityTitle)}</h3><p>Status: <strong>${esc(n.status)}</strong></p>${n.reviewReason ? `<p>${esc(n.reviewReason)}</p>` : ''}${n.accessExpiresAt ? `<p>Access expiry: ${esc(n.accessExpiresAt)}${n.accessRevokedAt ? ' (revoked)' : ''}</p>` : ''}${n.status === 'approved' && n.grantId && !n.accessRevokedAt ? `<button type="button" data-docs="${esc(n.opportunityId)}">View authorised documents</button><div id="docs-${esc(n.opportunityId)}"></div>` : ''}</div>`,
            )
            .join('')
        : '<p>No NDA requests yet.</p>';
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
  $('#request-code').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    email = String(form.get('email') || '').trim();
    try {
      await api('/api/buyer/auth/request-code', {
        method: 'POST',
        body: JSON.stringify({ email }),
      });
      $('#verify-code').hidden = false;
      notice.textContent =
        'If this email belongs to an eligible buyer account, a sign-in code will be sent.';
    } catch (error) {
      notice.textContent = error.message;
    }
  });
  $('#verify-code').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const code = String(form.get('code') || '').trim();
    try {
      await api('/api/buyer/auth/verify-code', {
        method: 'POST',
        body: JSON.stringify({ email, code }),
      });
      notice.textContent = 'Signed in.';
      await loadAccount();
    } catch (error) {
      notice.textContent = error.message;
    }
  });
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
