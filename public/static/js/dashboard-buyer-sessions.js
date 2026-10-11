(() => {
  const rows = document.getElementById('buyer-session-rows');
  const status = document.getElementById('buyer-session-status');
  if (!rows || !status) return;
  const el = (tag, value) => {
    const node = document.createElement(tag);
    node.textContent = value == null || value === '' ? '—' : String(value);
    return node;
  };
  const date = (value) => value ? `${value} UTC` : '—';
  async function request(url, options = {}) {
    const response = await fetch(url, {
      credentials: 'same-origin',
      headers: { Accept: 'application/json', ...(options.body ? { 'Content-Type': 'application/json' } : {}) },
      ...options,
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body?.error?.message || 'Request failed.');
    return body;
  }
  async function load() {
    status.textContent = 'Loading active buyer sessions…';
    rows.replaceChildren();
    try {
      const body = await request('/dashboard/buyer-sessions');
      const sessions = body.data || [];
      if (!sessions.length) {
        const emptyRow = document.createElement('tr');
        const emptyCell = el('td', 'No active buyer sessions.');
        emptyCell.colSpan = 6;
        emptyRow.append(emptyCell);
        rows.append(emptyRow);
      }
      for (const session of sessions) {
        const row = document.createElement('tr');
        row.append(el('td', `${session.displayName || session.email} · ${session.email}`));
        row.append(el('td', session.accountStatus));
        row.append(el('td', date(session.createdAt)));
        row.append(el('td', date(session.lastSeenAt)));
        row.append(el('td', date(session.expiresAt)));
        const action = document.createElement('td');
        const button = el('button', 'Revoke session');
        button.type = 'button';
        button.addEventListener('click', async () => {
          if (!window.confirm(`Revoke this buyer session for ${session.email}? The buyer will need to sign in again on that device.`)) return;
          button.disabled = true;
          try {
            await request(`/dashboard/buyer-sessions/${encodeURIComponent(session.id)}/revoke`, { method: 'POST', body: '{}' });
            status.textContent = `Session revoked for ${session.email}.`;
            await load();
          } catch (error) {
            status.textContent = error instanceof Error ? error.message : 'Could not revoke the session.';
            button.disabled = false;
          }
        });
        action.append(button);
        row.append(action);
        rows.append(row);
      }
      status.textContent = `${sessions.length} active buyer session${sessions.length === 1 ? '' : 's'} shown (maximum 500).`;
    } catch (error) {
      status.textContent = error instanceof Error ? error.message : 'Could not load buyer sessions.';
      rows.append(el('tr', 'Sessions could not be loaded.'));
    }
  }
  load();
})();
