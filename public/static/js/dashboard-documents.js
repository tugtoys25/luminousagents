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
  const scannerState = document.querySelector('#scanner-state');
  const scannerForm = document.querySelector('#scanner-form');
  const scannerNotice = document.querySelector('#scanner-notice');
  const scannerToggle = document.querySelector('#scanner-toggle');
  const scannerRelease = document.querySelector('#scanner-release-label');
  let scannerMode = 'enforced';
  function renderScanner(info) {
    scannerMode = info.mode === 'disabled' ? 'disabled' : 'enforced';
    const off = scannerMode === 'disabled';
    scannerState.innerHTML = off
      ? '<strong>Scanner is OFF.</strong> New uploads and signed NDA PDFs are released without a malware scan. Each one is recorded as <code>scan-disabled</code> in the audit log.'
      : `<strong>Scanner is ON.</strong> Files stay unavailable until a verified clean result.${info.scannerConfigured ? '' : ' No scanner service is configured yet, so scans will fail until one is set up.'}`;
    scannerState.className = off ? 'dx-note dx-note-warn' : 'muted';
    if (role === 'admin' || role === 'super_admin') {
      scannerForm.hidden = false;
      scannerToggle.textContent = off ? 'Switch scanner on' : 'Switch scanner off';
      scannerRelease.hidden = off;
    }
  }
  async function loadScanner() { renderScanner(await api('/dashboard/scanner-settings')); }
  scannerForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = new FormData(scannerForm);
    const next = scannerMode === 'disabled' ? 'enforced' : 'disabled';
    const warning = next === 'disabled'
      ? 'Switch the scanner OFF? Uploaded files and signed NDA PDFs will reach buyers without a malware check.'
      : 'Switch the scanner back ON? Files released while it was off stay available.';
    if (!confirm(warning)) return;
    scannerToggle.disabled = true; scannerNotice.textContent = 'Saving…';
    try {
      const result = await api('/dashboard/scanner-settings', { method: 'PUT', body: JSON.stringify({ mode: next, reason: String(form.get('reason') || ''), releasePending: form.get('releasePending') === 'on' }) });
      scannerNotice.textContent = result.releasedPending ? `Scanner is now ${next === 'disabled' ? 'off' : 'on'}. ${result.releasedPending} waiting document(s) released.` : `Scanner is now ${next === 'disabled' ? 'off' : 'on'}.`;
      scannerForm.reset(); await loadScanner(); await load();
    } catch (error) { scannerNotice.textContent = error.message || 'Could not change the scanner setting.'; }
    finally { scannerToggle.disabled = false; }
  });
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
      rows.innerHTML = items.map((item) => `<tr><td>${esc(item.filename)}<br><small>${esc(item.contentType)} · ${(Number(item.byteSize || 0) / 1048576).toFixed(2)} MiB</small></td><td>${esc(item.opportunityTitle)}</td><td>${esc(item.tier)}</td><td><strong>${esc(item.scanStatus)}</strong>${item.scanProvider ? `<br><small>${esc(item.scanProvider)} · ${esc(item.scannedAt || '')}</small>` : ''}</td><td>${esc(item.createdAt)}</td><td>${item.scanStatus === 'pending' && (role === 'admin' || role === 'super_admin') ? `<button type="button" data-scan="${esc(item.id)}">${scannerMode === 'disabled' ? 'Release (no scan)' : 'Scan now'}</button>` : ''} ${(role === 'admin' || role === 'publisher' || role === 'super_admin') ? `<button type="button" class="danger" data-delete="${esc(item.id)}">Delete</button>` : ''}</td></tr>`).join('') || '<tr><td colspan="6">No documents found.</td></tr>';
      notice.textContent = `${items.length} document(s) shown. Pending and rejected documents cannot be downloaded by buyers.`;
      rows.querySelectorAll('[data-scan]').forEach((button) => button.addEventListener('click', async () => {
        if (!confirm(scannerMode === 'disabled' ? 'Release this document to buyers without a malware scan?' : 'Scan the exact stored document bytes using the configured trusted scanner?')) return;
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
    try { await api(`/dashboard/opportunities/${encodeURIComponent(opportunityId)}/documents`, { method: 'POST', body: data }); uploadNotice.textContent = scannerMode === 'disabled' ? 'Document uploaded to private storage and released without a scan (scanner is off).' : 'Document uploaded to private storage. It remains unavailable until a trusted scanner marks it clean.'; uploadForm.elements.namedItem('file').value = ''; filter.value = opportunityId; await load(); }
    catch (error) { uploadNotice.textContent = error.message || 'Upload failed.'; }
    finally { button.disabled = false; }
  });
  filter.addEventListener('change', load);
  loadScanner().catch((error) => { scannerState.textContent = error.message || 'Could not load scanner status.'; }).then(loadOpportunities).then(load).catch((error) => { notice.textContent = error.message || 'Could not load opportunities.'; });
})();
