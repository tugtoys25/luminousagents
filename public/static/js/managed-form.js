(() => {
  const script = document.currentScript;
  const slug = script?.dataset.formSlug;
  const f = document.querySelector('#managed-public-form');
  if (!f || !slug) return;
  f.addEventListener('submit', async (e) => {
    e.preventDefault();
    const data = Object.fromEntries(new FormData(f));
    const n = document.querySelector('#form-notice');
    n.textContent = 'Submitting…';
    try {
      const r = await fetch('/api/forms/' + encodeURIComponent(slug) + '/submit', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(data),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error?.message || 'Please check the form.');
      f.reset();
      n.textContent = 'Thank you. Your request has been received.';
    } catch (err) {
      n.textContent = err.message || 'Could not submit the form.';
    } finally {
      if (window.mayfairResetTurnstile) window.mayfairResetTurnstile(f);
    }
  });
})();
