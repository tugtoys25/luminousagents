const notice = document.getElementById('notice');
const list = document.getElementById('staff-list');
const esc = (v) =>
  String(v ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
const roles = ['super_admin', 'admin', 'editor', 'broker', 'publisher', 'auditor'];
async function call(url, method, body) {
  const response = await fetch(url, {
    method,
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error?.message || 'Request failed.');
  return payload.data;
}
async function load() {
  try {
    const rows = await call('/dashboard/staff', 'GET');
    list.innerHTML =
      rows
        .map(
          (u) =>
            `<article class="buyer"><div><strong>${esc(u.displayName)}</strong><p>${esc(u.email)} · ${esc(u.role)} · ${esc(u.status)}${u.hasPassword ? '' : ' · no password set'}</p></div><form data-id="${esc(u.id)}"><select name="role">${roles.map((r) => `<option value="${r}"${r === u.role ? ' selected' : ''}>${r}</option>`).join('')}</select> <select name="status"><option value="active"${u.status === 'active' ? ' selected' : ''}>Active</option><option value="suspended"${u.status === 'suspended' ? ' selected' : ''}>Suspended</option></select> <button type="submit">Save</button> <button type="button" data-reset="${esc(u.id)}">Send reset link</button></form></article>`,
        )
        .join('') || '<p>No staff accounts.</p>';
    list.querySelectorAll('form[data-id]').forEach((form) =>
      form.addEventListener('submit', async (event) => {
        event.preventDefault();
        const f = new FormData(form);
        try {
          await call(`/dashboard/staff/${form.dataset.id}`, 'PATCH', {
            role: f.get('role'),
            status: f.get('status'),
          });
          notice.textContent = 'Staff account updated.';
          await load();
        } catch (e) {
          notice.textContent = e.message;
        }
      }),
    );
    list.querySelectorAll('[data-reset]').forEach((b) =>
      b.addEventListener('click', async () => {
        try {
          const r = await call(`/dashboard/staff/${b.dataset.reset}/reset-password`, 'POST', {});
          notice.textContent = r.emailQueued
            ? 'Password reset link queued.'
            : 'Email delivery is not configured; use the temporary-password option when creating accounts.';
        } catch (e) {
          notice.textContent = e.message;
        }
      }),
    );
  } catch (e) {
    notice.textContent = e.message;
  }
}
document.getElementById('staff-create').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const body = Object.fromEntries(new FormData(form));
  if (!body.temporaryPassword) delete body.temporaryPassword;
  try {
    const r = await call('/dashboard/staff', 'POST', body);
    notice.textContent = r.invited
      ? 'Staff account created. A set-password email has been queued.'
      : 'Staff account created with a temporary password; they must change it at first sign-in.';
    form.reset();
    await load();
  } catch (e) {
    notice.textContent = e.message;
  }
});
load();
