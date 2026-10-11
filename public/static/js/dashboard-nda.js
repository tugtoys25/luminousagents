(() => {
  const list = document.querySelector('#requests');
  const notice = document.querySelector('#notice');
  const filter = document.querySelector('#status-filter');
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
  async function load() {
    list.textContent = 'Loading requests…';
    try {
      const suffix = filter.value ? `?status=${encodeURIComponent(filter.value)}` : '';
      const rows = await api(`/dashboard/nda-requests${suffix}`);
      if (!rows.length) {
        list.textContent = 'No requests match this filter.';
        return;
      }
      list.innerHTML = rows
        .map(
          (r) =>
            `<article class="request"><header><div><h2>${esc(r.opportunityTitle)}</h2><p>${esc(r.buyerName || r.buyerEmail)} · ${esc(r.buyerEmail)}</p></div><p class="status">${esc(r.status)}</p></header><p>Buyer acknowledgement name: ${esc(r.acceptanceName || 'Not provided')}</p>${r.hasSignedPdf ? `<p><a href="/dashboard/nda-requests/${encodeURIComponent(r.id)}/signed-pdf">Download signed NDA PDF (audited)</a></p>` : '<p class="muted">No signed PDF uploaded.</p>'}<p class="muted">Requested: ${esc(r.createdAt)}${r.reviewReason ? ` · Previous review note: ${esc(r.reviewReason)}` : ''}</p>${r.status === 'pending' ? `<form data-id="${esc(r.id)}"><label>Decision<select name="decision"><option value="approved">Approve</option><option value="rejected">Reject</option></select></label><label>Access duration (days)<input name="accessDays" type="number" min="1" max="90" value="30" required></label><label>Document tier<select name="tier"><option value="1">Tier 1</option><option value="2" selected>Tier 2</option><option value="3">Tier 3 — super administrator only</option></select></label><label style="grid-column:1/-1">Review reason<textarea name="reason" minlength="3" maxlength="1000" required></textarea></label><button type="submit">Record decision</button></form>` : ''}</article>`,
        )
        .join('');
      const staffRole = document.querySelector('meta[name="mayfair-staff"]')?.content;
      if (staffRole !== 'super_admin') list.querySelectorAll('select[name="tier"] option[value="3"]').forEach((option) => { option.disabled = true; });
      list.querySelectorAll('form[data-id]').forEach((form) =>
        form.addEventListener('submit', async (event) => {
          event.preventDefault();
          const fd = new FormData(form);
          const reason = String(fd.get('reason') || '').trim();
          if (!reason) {
            notice.textContent = 'A review reason is required.';
            return;
          }
          const button = form.querySelector('button');
          button.disabled = true;
          try {
            await api(`/dashboard/nda-requests/${encodeURIComponent(form.dataset.id)}/review`, {
              method: 'PATCH',
              body: JSON.stringify({
                decision: fd.get('decision'),
                reason,
                accessDays: Number(fd.get('accessDays')),
                tier: Number(fd.get('tier')),
              }),
            });
            notice.textContent = 'Decision recorded.';
            await load();
          } catch (error) {
            notice.textContent = error.message;
            button.disabled = false;
          }
        }),
      );
    } catch (error) {
      list.textContent = error.message;
    }
  }
  filter.addEventListener('change', load);
  load();
})();
