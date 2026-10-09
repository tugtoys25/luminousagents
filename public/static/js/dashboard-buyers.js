const form = document.querySelector('#buyer-provision');
const list = document.querySelector('#buyer-list');
const notice = document.querySelector('#buyer-notice');
async function api(url, options = {}) {
  const r = await fetch(url, {
    credentials: 'same-origin',
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body?.error?.message || `Request failed (${r.status})`);
  return body.data;
}
async function refresh() {
  list.textContent = 'Loading…';
  try {
    const rows = await api('/dashboard/buyers');
    list.replaceChildren();
    for (const buyer of rows) {
      const li = document.createElement('li');
      li.textContent = `${buyer.displayName} · ${buyer.email} · ${buyer.status}`;
      list.append(li);
    }
    if (!rows.length) list.textContent = 'No buyer accounts yet.';
  } catch (e) {
    list.textContent = e.message;
  }
}
form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const data = Object.fromEntries(new FormData(form));
  try {
    const buyer = await api('/dashboard/buyers/provision', {
      method: 'POST',
      body: JSON.stringify(data),
    });
    notice.textContent = `Provisioned ${buyer.email}. Ask the buyer to use the email OTP sign-in flow.`;
    form.reset();
    await refresh();
  } catch (e) {
    notice.textContent = e.message;
  }
});
document.querySelector('#buyer-refresh').addEventListener('click', refresh);
refresh();
