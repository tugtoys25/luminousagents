(() => {
  const form = document.getElementById('audit-filters');
  const rows = document.getElementById('audit-rows');
  const status = document.getElementById('audit-status');
  const pageLabel = document.getElementById('audit-page');
  const prev = document.getElementById('audit-prev');
  const next = document.getElementById('audit-next');
  const exportButton = document.getElementById('audit-export');
  if (!form || !rows || !status) return;
  let page = 1;
  let pages = 1;
  const el = (tag, value) => {
    const node = document.createElement(tag);
    node.textContent = value == null || value === '' ? '—' : String(value);
    return node;
  };
  const currentFilters = () => ({
    search: document.getElementById('audit-search').value.trim(),
    action: document.getElementById('audit-action').value.trim(),
    entityType: document.getElementById('audit-entity').value.trim(),
    from: document.getElementById('audit-from').value,
    to: document.getElementById('audit-to').value,
  });
  async function load() {
    status.textContent = 'Loading audit events…';
    rows.replaceChildren();
    const params = new URLSearchParams({ page: String(page), limit: '50', ...currentFilters() });
    try {
      const response = await fetch(`/dashboard/audit?${params}`, { credentials: 'same-origin', headers: { Accept: 'application/json' } });
      const body = await response.json();
      if (!response.ok) throw new Error(body?.error?.message || 'Could not load audit events.');
      pages = Math.max(1, body.pages || 1);
      for (const item of body.data || []) {
        const row = document.createElement('tr');
        row.append(el('td', item.createdAt ? `${item.createdAt} UTC` : '—'));
        row.append(el('td', item.actorEmail || 'System / public'));
        row.append(el('td', item.action));
        row.append(el('td', `${item.entityType || '—'} · ${item.entityId || '—'}`));
        const detailsCell = document.createElement('td');
        const details = document.createElement('details');
        details.append(el('summary', 'View metadata'));
        let pretty = item.details;
        try { if (typeof pretty === 'string') pretty = JSON.stringify(JSON.parse(pretty), null, 2); } catch { /* display malformed legacy metadata as text */ }
        const pre = document.createElement('pre');
        pre.textContent = typeof pretty === 'string' ? pretty : JSON.stringify(pretty ?? {}, null, 2);
        pre.style.maxWidth = '32rem'; pre.style.whiteSpace = 'pre-wrap'; pre.style.overflowWrap = 'anywhere';
        details.append(pre); detailsCell.append(details); row.append(detailsCell); rows.append(row);
      }
      if (!(body.data || []).length) { const empty = document.createElement('tr'); const cell = el('td', 'No audit events match these filters.'); cell.colSpan = 5; empty.append(cell); rows.append(empty); }
      status.textContent = `${body.total || 0} event(s) · showing page ${body.page} of ${pages}`;
      pageLabel.textContent = `Page ${body.page} of ${pages}`;
      prev.disabled = page <= 1;
      next.disabled = page >= pages;
    } catch (error) {
      status.textContent = error instanceof Error ? error.message : 'Could not load audit events.';
      rows.replaceChildren();
      prev.disabled = true; next.disabled = true;
    }
  }
  form.addEventListener('submit', (event) => { event.preventDefault(); page = 1; void load(); });
  document.getElementById('audit-reset').addEventListener('click', () => { form.reset(); page = 1; void load(); });
  prev.addEventListener('click', () => { if (page > 1) { page -= 1; void load(); } });
  next.addEventListener('click', () => { if (page < pages) { page += 1; void load(); } });
  exportButton?.addEventListener('click', () => {
    const params = new URLSearchParams(currentFilters());
    window.location.assign(`/dashboard/audit/export.csv?${params}`);
  });
  void load();
})();
