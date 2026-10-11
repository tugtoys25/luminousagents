(() => {
  'use strict';
  const uploadForm = document.querySelector('#document-upload');
  const opportunity = document.querySelector('#document-opportunity');
  const filter = document.querySelector('#document-filter');
  const rows = document.querySelector('#document-rows');
  const notice = document.querySelector('#document-notice');
  const uploadNotice = document.querySelector('#document-upload-notice');
  const role = document.querySelector('meta[name="mayfair-staff"]')?.content || '';
  const tierThreeOption = uploadForm.elements.namedItem('tier').querySelector('option[value="3"]');
  if (tierThreeOption && role !== 'super_admin') tierThreeOption.disabled = true;
  const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
  async function api(url, options = {}) {
    const response = await fetch(url, { credentials: 'same-origin', ...options, headers: { ...(options.body && !(options.body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}), ...(options.headers || {}) } });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error?.message || 'Request failed.');
    return payload.data;
  }
  async function loadOpportunities() {
    const result = await api('/dashboard/opportunities');
    const options = (result || []).map((item) => `<option value="${esc(item.id)}">${esc(item.title)}${item.country ? ` — ${esc(item.country)}` : ''}</option>`).join('');
    opportunity.innerHTML = '<option value="">Choose an opportunity</option>' + options;
    filter.innerHTML = '<option value="">All opportunities</option>' + options;
  }
  async function load() {
    notice.textContent = 'Loading documents…';
    try {
      const suffix = filter.value ? `?opportunityId=${encodeURIComponent(filter.value)}` : '';
      const result = await api(`/dashboard/documents${suffix}`);
      const items = result || [];
      rows.innerHTML = items.map((item) => `<tr><td>${esc(item.filename)}<br><small>${esc(item.contentType)} · ${(Number(item.byteSize || 0) / 1048576).toFixed(2)} MiB</small></td><td>${esc(item.opportunityTitle)}</td><td>${esc(item.tier)}</td><td><strong>${esc(item.scanStatus)}</strong>${item.scanProvider ? `<br><small>${esc(item.scanProvider)} · ${esc(item.scannedAt || '')}</small>` : ''}</td><td>${esc(item.createdAt)}</td><td>${item.scanStatus === 'pending' && (role === 'admin' || role === 'super_admin') ? `<button type="button" data-scan="${esc(item.id)}">Scan now</button>` : ''} ${(role === 'admin' || role === 'publisher' || role === 'super_admin') ? `<button type="button" class="danger" data-delete="${esc(item.id)}">Delete</button>` : ''}</td></tr>`).join('') || '<tr><td colspan="6">No documents found.</td></tr>';
      notice.textContent = `${items.length} document(s) shown. Pending and rejected documents cannot be downloaded by buyers.`;
      rows.querySelectorAll('[data-scan]').forEach((button) => button.addEventListener('click', async () => {
        if (!confirm('Scan the exact stored document bytes using the configured trusted scanner?')) return;
        button.disabled = true; notice.textContent = 'Scanning document…';
        try { const result = await api(`/dashboard/documents/${encodeURIComponent(button.dataset.scan)}/scan`, { method: 'POST', body: JSON.stringify({}) }); notice.textContent = `Scan complete: ${result.scanStatus}.`; await load(); }
        catch (error) { notice.textContent = error.message || 'Scan failed; the file remains unavailable.'; button.disabled = false; }
      }));
      rows.querySelectorAll('[data-delete]').forEach((button) => button.addEventListener('click', async () => {
        if (!confirm('Permanently delete this private data-room document? This cannot be undone.')) return;
        button.disabled = true;
        try { await api(`/dashboard/documents/${encodeURIComponent(button.dataset.delete)}`, { method: 'DELETE' }); notice.textContent = 'Document deleted.'; await load(); }
        catch (error) { notice.textContent = error.message || 'Could not delete document.'; button.disabled = false; }
      }));
    } catch (error) { notice.textContent = error.message || 'Could not load documents.'; }
  }
  uploadForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const data = new FormData(uploadForm);
    const opportunityId = String(data.get('opportunityId') || '');
    if (!opportunityId) { uploadNotice.textContent = 'Choose an opportunity.'; return; }
    const button = uploadForm.querySelector('button[type="submit"]'); button.disabled = true; uploadNotice.textContent = 'Uploading to private storage…';
    try { await api(`/dashboard/opportunities/${encodeURIComponent(opportunityId)}/documents`, { method: 'POST', body: data }); uploadNotice.textContent = 'Document uploaded to private storage. It remains unavailable until a trusted scanner marks it clean.'; uploadForm.elements.namedItem('file').value = ''; filter.value = opportunityId; await load(); }
    catch (error) { uploadNotice.textContent = error.message || 'Upload failed.'; }
    finally { button.disabled = false; }
  });
  filter.addEventListener('change', load);
  loadOpportunities().then(load).catch((error) => { notice.textContent = error.message || 'Could not load opportunities.'; });
})();
