(() => {
  const rows = document.getElementById('session-rows');
  const status = document.getElementById('session-status');
  if (!rows || !status) return;
  const el = (tag, value) => {
    const node = document.createElement(tag);
    node.textContent = value == null || value === '' ? '—' : String(value);
    return node;
  };
  const date = (value) => value ? `${value} UTC` : '—';
  async function request(url, options = {}) {
    const response = await fetch(url, { credentials: 'same-origin', headers: { Accept: 'application/json', ...(options.body ? { 'Content-Type': 'application/json' } : {}) }, ...options });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body?.error?.message || 'Request failed.');
    return body;
  }
  async function load() {
    status.textContent = 'Loading active staff sessions…';
    rows.replaceChildren();
    try {
      const body = await request('/dashboard/sessions');
      const sessions = body.data || [];
      for (const session of sessions) {
        const row = document.createElement('tr');
        row.append(el('td', `${session.displayName || session.email} · ${session.email}`));
        row.append(el('td', session.role));
        row.append(el('td', date(session.createdAt)));
        row.append(el('td', date(session.lastSeenAt)));
        row.append(el('td', date(session.expiresAt)));
        row.append(el('td', session.isCurrent ? 'Current session' : 'Active'));
        const action = document.createElement('td');
        if (session.isCurrent) action.append(el('span', 'Protected'));
        else {
          const button = el('button', 'Revoke session');
          button.type = 'button';
          button.addEventListener('click', async () => {
            if (!window.confirm(`Revoke this session for ${session.email}? That sign-in will lose access.`)) return;
            button.disabled = true;
            try { await request(`/dashboard/sessions/${encodeURIComponent(session.id)}/revoke`, { method: 'POST', body: '{}' }); await load(); }
            catch (error) { status.textContent = error instanceof Error ? error.message : 'Could not revoke session.'; button.disabled = false; }
          });
          action.append(button);
        }
        row.append(action); rows.append(row);
      }
      if (!sessions.length) { const row = document.createElement('tr'); const cell = el('td', 'No active staff sessions.'); cell.colSpan = 7; row.append(cell); rows.append(row); }
      status.textContent = `${sessions.length} active staff session(s) shown. The list is capped at 500 sessions.`;
    } catch (error) {
      status.textContent = error instanceof Error ? error.message : 'Could not load staff sessions.';
      rows.replaceChildren();
    }
  }
  void load();
})();
