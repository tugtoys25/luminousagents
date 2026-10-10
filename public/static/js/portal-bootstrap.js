const form = document.getElementById('bootstrap-form');
if (form) form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = form.querySelector('button');
  const notice = document.getElementById('notice');
  button.disabled = true;
  notice.textContent = 'Creating administrator…';
  try {
    const response = await fetch('/api/admin/bootstrap', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(Object.fromEntries(new FormData(form))) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error?.message || 'Setup failed.');
    notice.textContent = 'Administrator registered. Setup is now closed. Continue to staff sign in.';
    form.reset();
  } catch (error) {
    notice.textContent = error instanceof Error ? error.message : 'Unable to complete setup.';
  } finally { button.disabled = false; }
});
