(() => {
  'use strict';
  const rows = document.querySelector('#review-queue-rows');
  const notice = document.querySelector('#review-queue-notice');
  const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
  async function load() {
    notice.textContent = 'Loading review queue…';
    try {
      const response = await fetch('/dashboard/opportunities/review-queue', { credentials: 'same-origin', headers: { Accept: 'application/json' } });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error?.message || 'Could not load the review queue.');
      const items = payload.data || [];
      rows.innerHTML = items.map((item) => `<tr><td>${esc(item.title)}</td><td>${esc(item.country || 'Missing')}</td><td>${esc(item.lifecycle)} / ${esc(item.reviewStatus)}</td><td>${(item.reasons || []).map(esc).join(', ')}</td><td>${esc(item.lastVerifiedAt || 'Never')}</td><td><a href="/dashboard/opportunities/ui?selected=${encodeURIComponent(item.id)}">Open record</a></td></tr>`).join('') || '<tr><td colspan="6">No records need review.</td></tr>';
      notice.textContent = `${items.length} record(s) shown${payload.truncated ? ' — queue capped at 250; refine the queue before bulk work.' : ''}. Nothing was published.`;
    } catch (error) { notice.textContent = error.message || 'Could not load the review queue.'; }
  }
  load();
})();
