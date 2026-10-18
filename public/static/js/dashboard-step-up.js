/* Step-up re-verification. When a sensitive staff action is refused with STEP_UP_REQUIRED, ask for an
 * authenticator (or recovery) code in a dialog, verify it with the server, then repeat the original request once.
 * Progressive enhancement: without this script the error message still explains where to verify.
 * Authorization is always enforced on the server; nothing here grants access. */
(() => {
  'use strict';
  if (window.__mayfairStepUp) return;
  window.__mayfairStepUp = true;
  const nativeFetch = window.fetch.bind(window);
  let pending = null;

  const sameOriginStaffApi = (input) => {
    try {
      const url = new URL(typeof input === 'string' ? input : input.url, window.location.href);
      return (
        url.origin === window.location.origin &&
        (url.pathname.startsWith('/dashboard') || url.pathname.startsWith('/api/admin/')) &&
        !url.pathname.startsWith('/api/admin/mfa/verify')
      );
    } catch {
      return false;
    }
  };

  const el = (tag, props = {}, children = []) => {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(props)) {
      if (key === 'text') node.textContent = value;
      else node.setAttribute(key, value);
    }
    for (const child of children) node.append(child);
    return node;
  };

  function prompt() {
    if (pending) return pending;
    pending = new Promise((resolve) => {
      let recovery = false;
      const notice = el('p', { class: 'step-up-notice', role: 'status', 'aria-live': 'polite' });
      const input = el('input', { id: 'step-up-code', name: 'code', inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: '16', required: '' });
      const label = el('label', { for: 'step-up-code', text: 'Authenticator code' });
      const toggle = el('button', { type: 'button', class: 'step-up-link', text: 'Use a recovery code instead' });
      const submit = el('button', { type: 'submit', text: 'Verify and continue' });
      const cancel = el('button', { type: 'button', class: 'step-up-cancel', text: 'Cancel' });
      const form = el('form', { novalidate: '' }, [
        el('div', { class: 'field' }, [label, input]),
        notice,
        el('div', { class: 'step-up-actions' }, [submit, cancel]),
        toggle,
      ]);
      const dialog = el('dialog', { class: 'step-up-dialog', 'aria-labelledby': 'step-up-title' }, [
        el('h2', { id: 'step-up-title', text: 'Confirm it is you' }),
        el('p', { class: 'muted', text: 'This action needs a recent two-factor check. Enter your code to continue.' }),
        form,
      ]);
      const finish = (ok) => {
        dialog.close();
        dialog.remove();
        pending = null;
        resolve(ok);
      };
      toggle.addEventListener('click', () => {
        recovery = !recovery;
        label.textContent = recovery ? 'Recovery code' : 'Authenticator code';
        input.setAttribute('inputmode', recovery ? 'text' : 'numeric');
        input.setAttribute('autocomplete', recovery ? 'off' : 'one-time-code');
        toggle.textContent = recovery ? 'Use my authenticator app instead' : 'Use a recovery code instead';
        input.value = '';
        input.focus();
      });
      cancel.addEventListener('click', () => finish(false));
      dialog.addEventListener('cancel', (event) => {
        event.preventDefault();
        finish(false);
      });
      form.addEventListener('submit', async (event) => {
        event.preventDefault();
        const value = input.value.trim();
        if (!value) return;
        submit.disabled = true;
        notice.textContent = 'Checking…';
        try {
          const response = await nativeFetch('/api/admin/mfa/verify', {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(recovery ? { recoveryCode: value } : { code: value }),
          });
          const data = await response.json().catch(() => ({}));
          if (response.ok) return finish(true);
          notice.textContent = (data.error && data.error.message) || 'That code did not work. Try again.';
        } catch {
          notice.textContent = 'Could not reach the server. Try again.';
        }
        submit.disabled = false;
        input.select();
      });
      document.body.append(dialog);
      dialog.showModal();
      input.focus();
    });
    return pending;
  }

  window.fetch = async (input, init) => {
    const retryable = input instanceof window.Request ? input.clone() : null;
    const response = await nativeFetch(input, init);
    if (response.status !== 403 || !sameOriginStaffApi(input)) return response;
    let code = '';
    try {
      const body = await response.clone().json();
      code = (body && body.error && body.error.code) || '';
    } catch {
      return response;
    }
    if (code !== 'STEP_UP_REQUIRED') return response;
    if (!(await prompt())) return response;
    return nativeFetch(retryable || input, retryable ? undefined : init);
  };
})();
