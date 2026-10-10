const notice = document.getElementById('notice');
function escapeHtml(value) {
  return String(value ?? '').replace(
    /[&<>"']/g,
    (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch],
  );
}
async function loadBuyers() {
  try {
    const response = await fetch('/dashboard/buyers');
    const data = await response.json();
    if (!response.ok) throw new Error(data.error?.message || 'Unable to load buyers.');
    document.getElementById('buyers').innerHTML =
      (data.data || [])
        .map(
          (user) =>
            `<article class="buyer"><div><strong>${escapeHtml(user.displayName)}</strong><p>${escapeHtml(user.email)} · ${escapeHtml(user.companyName || 'Company not provided')}</p><p>Status: ${escapeHtml(user.status)} · Registered ${escapeHtml((user.createdAt || '').slice(0, 10))}</p></div><form data-id="${escapeHtml(user.id)}"><select name="status"><option value="active" ${user.status === 'active' ? 'selected' : ''}>Active</option><option value="invited" ${user.status === 'invited' ? 'selected' : ''}>Invited</option><option value="suspended" ${user.status === 'suspended' ? 'selected' : ''}>Suspended</option></select> <button>Save access</button></form></article>`,
        )
        .join('') || '<p>No buyer registrations yet.</p>';
    document.querySelectorAll('form[data-id]').forEach((form) =>
      form.addEventListener('submit', async (event) => {
        event.preventDefault();
        const response = await fetch(`/dashboard/buyers/${form.dataset.id}`, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ status: new FormData(form).get('status') }),
        });
        const result = await response.json();
        notice.textContent = response.ok
          ? 'Buyer access updated.'
          : result.error?.message || 'Unable to update buyer.';
        if (response.ok) await loadBuyers();
      }),
    );
  } catch (error) {
    notice.textContent = error instanceof Error ? error.message : 'Unable to load buyers.';
  }
}
loadBuyers();
