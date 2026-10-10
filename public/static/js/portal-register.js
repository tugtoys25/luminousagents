const form = document.getElementById('buyer-register');
if (form) form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = form.querySelector('button');
  const notice = document.getElementById('notice');
  button.disabled = true;
  notice.textContent = 'Submitting…';
  try {
    const response = await fetch('/api/buyer/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...Object.fromEntries(new FormData(form)), consent: new FormData(form).get('consent') === 'on' }) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error?.message || 'Registration could not be submitted.');
    notice.textContent = data.data?.message || 'Registration received. The team will review it.';
    form.reset();
  } catch (error) {
    notice.textContent = error instanceof Error ? error.message : 'Registration could not be submitted.';
  } finally { button.disabled = false; }
});
