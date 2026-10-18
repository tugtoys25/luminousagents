/* Staff two-factor pages: verify a code, or set up an authenticator app. */
(() => {
  const post = async (url, body) => {
    const response = await fetch(url, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body || {}),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok)
      throw new Error((payload.error && payload.error.message) || 'Something went wrong. Please try again.');
    return payload.data || {};
  };
  const say = (node, text, ok) => {
    if (!node) return;
    node.textContent = text;
    node.classList.toggle('ok', Boolean(ok));
  };

  const verifyForm = document.querySelector('[data-mfa-form="verify"]');
  if (verifyForm) {
    const notice = verifyForm.querySelector('.notice');
    const recoveryField = document.getElementById('mfa-recovery-field');
    const useRecovery = document.getElementById('mfa-use-recovery');
    let recoveryMode = false;
    useRecovery.addEventListener('click', (event) => {
      event.preventDefault();
      recoveryMode = !recoveryMode;
      recoveryField.hidden = !recoveryMode;
      document.getElementById('mfa-code').required = !recoveryMode;
      useRecovery.textContent = recoveryMode ? 'Use my authenticator app instead' : 'Use a recovery code instead';
    });
    verifyForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      const button = verifyForm.querySelector('button[type="submit"]');
      const body = recoveryMode
        ? { recoveryCode: verifyForm.elements.recoveryCode.value }
        : { code: verifyForm.elements.code.value };
      if (verifyForm.dataset.next) body.next = verifyForm.dataset.next;
      button.disabled = true;
      say(notice, 'Checking…');
      try {
        const data = await post('/api/admin/mfa/verify', body);
        if (typeof data.recoveryCodesLeft === 'number' && data.recoveryCodesLeft < 3)
          say(notice, 'Verified. You have few recovery codes left; ask a super administrator to reset two-factor soon.', true);
        window.location.href = data.redirectTo || '/dashboard';
      } catch (error) {
        say(notice, error instanceof Error ? error.message : 'Something went wrong.');
        button.disabled = false;
      }
    });
  }

  const setup = document.querySelector('[data-mfa-form="setup"]');
  if (setup) {
    const notice = document.getElementById('mfa-setup-notice');
    const start = document.getElementById('mfa-start');
    const secretBox = document.getElementById('mfa-secret-box');
    start.addEventListener('click', async () => {
      start.disabled = true;
      say(notice, 'Preparing…');
      try {
        const data = await post('/api/admin/mfa/setup');
        document.getElementById('mfa-secret').textContent = data.secret;
        document.getElementById('mfa-uri').href = data.uri;
        secretBox.hidden = false;
        start.hidden = true;
        say(notice, '');
        document.getElementById('mfa-enable-code').focus();
      } catch (error) {
        say(notice, error instanceof Error ? error.message : 'Something went wrong.');
        start.disabled = false;
      }
    });
    const enable = document.getElementById('mfa-enable');
    enable.addEventListener('submit', async (event) => {
      event.preventDefault();
      const notice2 = enable.querySelector('.notice');
      const button = enable.querySelector('button[type="submit"]');
      button.disabled = true;
      say(notice2, 'Checking…');
      try {
        const data = await post('/api/admin/mfa/enable', { code: enable.elements.code.value });
        secretBox.hidden = true;
        document.getElementById('mfa-recovery-codes').textContent = (data.recoveryCodes || []).join('\n');
        document.getElementById('mfa-recovery-box').hidden = false;
      } catch (error) {
        say(notice2, error instanceof Error ? error.message : 'Something went wrong.');
        button.disabled = false;
      }
    });
    document.getElementById('mfa-done').addEventListener('click', () => {
      window.location.href = '/dashboard';
    });
  }
})();
