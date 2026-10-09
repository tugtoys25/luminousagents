const form = document.querySelector('#nda-template-form');
const list = document.querySelector('#nda-template-list');
const notice = document.querySelector('#nda-template-notice');
async function api(url, options = {}) {
  const r = await fetch(url, {
    credentials: 'same-origin',
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
  });
  const payload = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(payload?.error?.message || `Request failed (${r.status})`);
  return payload.data;
}
async function refresh() {
  list.textContent = 'Loading…';
  try {
    const rows = await api('/dashboard/nda-templates');
    list.replaceChildren();
    for (const row of rows) {
      const li = document.createElement('li');
      const label = document.createElement('span');
      label.textContent = `${row.name} v${row.version} · ${row.status} · SHA-256 ${row.contentHash}`;
      li.append(label);
      if (row.status !== 'active' && row.r2Key) {
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = 'Activate';
        button.addEventListener('click', async () => {
          if (!confirm('Activate this template? Confirm counsel approval first.')) return;
          try {
            await api(`/dashboard/nda-templates/${encodeURIComponent(row.id)}/activate`, {
              method: 'POST',
              body: '{}',
            });
            notice.textContent = 'Template activated.';
            await refresh();
          } catch (e) {
            notice.textContent = e.message;
          }
        });
        li.append(' ', button);
      }
      list.append(li);
    }
  } catch (e) {
    list.textContent = e.message;
  }
}
form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const data = Object.fromEntries(new FormData(form));
  data.activate = form.elements.namedItem('activate').checked;
  try {
    await api('/dashboard/nda-templates', { method: 'POST', body: JSON.stringify(data) });
    notice.textContent = 'Version created. Review its hash and legal approval before activation.';
    form.elements.namedItem('content').value = '';
    await refresh();
  } catch (e) {
    notice.textContent = e.message;
  }
});
refresh();
