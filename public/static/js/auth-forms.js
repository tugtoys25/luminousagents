// Shared handler for all email/password forms (login, register, forgot, reset, change, first admin).
document.querySelectorAll('form[data-auth-form]').forEach((form) => {
  const notice = form.querySelector('.notice');
  const button = form.querySelector('button[type="submit"]');
  const say = (text, ok) => {
    notice.textContent = text;
    notice.classList.toggle('ok', Boolean(ok));
  };
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!form.reportValidity()) return;
    const body = Object.fromEntries(new FormData(form));
    if ('confirmPassword' in body) {
      if (body.confirmPassword !== (body.password ?? body.newPassword)) return say('The passwords do not match.');
      delete body.confirmPassword;
    }
    const consent = form.querySelector('[name="consent"]');
    if (consent) body.consent = consent.checked;
    if (form.hasAttribute('data-token-from-query')) body.token = new URLSearchParams(window.location.search).get('token') || '';
    button.disabled = true;
    say('Please wait…');
    try {
      const response = await fetch(form.dataset.endpoint, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error?.message || 'Something went wrong. Please try again.');
      const data = payload.data || {};
      if (data.redirectTo) return void (window.location.href = data.redirectTo);
      if (form.dataset.successReload !== undefined) return void window.location.reload();
      form.reset();
      say(data.message || 'Done.', true);
      if (form.dataset.successRedirect) window.setTimeout(() => (window.location.href = form.dataset.successRedirect), 1500);
    } catch (error) {
      say(error instanceof Error ? error.message : 'Something went wrong. Please try again.');
    } finally {
      button.disabled = false;
    }
  });
});
