/* Shared dashboard helpers: API calls, toasts, dialogs, badges. Presentation only; the server enforces access. */
(() => {
  'use strict';
  const esc = (value) =>
    String(value ?? '').replace(
      /[&<>"']/g,
      (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch],
    );

  async function api(url, method = 'GET', body) {
    const response = await fetch(url, {
      method,
      credentials: 'same-origin',
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(payload.error?.message || 'Request failed.');
      error.code = payload.error?.code;
      throw error;
    }
    return payload.data;
  }

  function toast(message, kind = 'ok') {
    let host = document.querySelector('.dx-toasts');
    if (!host) {
      host = document.createElement('div');
      host.className = 'dx-toasts';
      host.setAttribute('role', 'status');
      host.setAttribute('aria-live', 'polite');
      document.body.append(host);
    }
    const item = document.createElement('div');
    item.className = `dx-toast dx-toast-${kind}`;
    item.textContent = message;
    host.append(item);
    setTimeout(() => item.remove(), kind === 'error' ? 7000 : 4200);
  }

  /** Opens a modal <dialog>. Returns { el, close }. */
  function modal(title, bodyHtml, options = {}) {
    const el = document.createElement('dialog');
    el.className = `dx-dialog${options.wide ? ' dx-dialog-wide' : ''}`;
    el.innerHTML = `<div class="dx-dialog-head"><h2>${esc(title)}</h2><button type="button" class="dx-icon-btn" data-close aria-label="Close">×</button></div><div class="dx-dialog-body">${bodyHtml}</div>`;
    document.body.append(el);
    const close = () => {
      if (el.open) el.close();
    };
    el.addEventListener('close', () => el.remove());
    el.addEventListener('click', (event) => {
      if (event.target === el || event.target.closest('[data-close]')) close();
    });
    el.showModal();
    const first = el.querySelector('input:not([type=hidden]), select, textarea');
    if (first) first.focus();
    return { el, close };
  }

  function confirmBox({ title, message, confirmLabel = 'Confirm', danger = false }) {
    return new Promise((resolve) => {
      const { el, close } = modal(
        title,
        `<p class="dx-confirm-text">${esc(message)}</p><div class="dx-actions"><button type="button" class="dx-btn" data-no>Cancel</button><button type="button" class="dx-btn ${danger ? 'dx-btn-danger' : 'dx-btn-primary'}" data-yes>${esc(confirmLabel)}</button></div>`,
      );
      let answered = false;
      const answer = (value) => {
        answered = true;
        resolve(value);
        close();
      };
      el.querySelector('[data-yes]').addEventListener('click', () => answer(true));
      el.querySelector('[data-no]').addEventListener('click', () => answer(false));
      el.addEventListener('close', () => {
        if (!answered) resolve(false);
      });
    });
  }

  async function copy(text) {
    try {
      await navigator.clipboard.writeText(text);
      toast('Copied to clipboard.');
    } catch {
      toast('Copy failed. Select the text and copy it manually.', 'error');
    }
  }

  const TONES = {
    active: 'ok',
    approved: 'ok',
    published: 'ok',
    invited: 'warn',
    pending: 'warn',
    in_review: 'warn',
    draft: 'muted',
    suspended: 'danger',
    rejected: 'danger',
    sold: 'info',
    archived: 'muted',
    off_market: 'muted',
    on_hold: 'warn',
    under_offer: 'info',
  };
  const badge = (text, tone) =>
    `<span class="dx-badge dx-badge-${tone || TONES[String(text).toLowerCase()] || 'muted'}">${esc(String(text).replace(/_/g, ' '))}</span>`;

  const fmtDate = (iso) => {
    const time = Date.parse(iso || '');
    return Number.isNaN(time)
      ? '–'
      : new Date(time).toLocaleDateString(undefined, {
          day: 'numeric',
          month: 'short',
          year: 'numeric',
        });
  };

  const debounce = (fn, wait = 200) => {
    let timer;
    return (...args) => {
      clearTimeout(timer);
      timer = setTimeout(() => fn(...args), wait);
    };
  };

  /** Browser-side generator for a readable temporary password (same alphabet as the server). */
  function generatePassword() {
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
    const limit = 256 - (256 % alphabet.length);
    for (;;) {
      let out = '';
      while (out.length < 14)
        for (const byte of crypto.getRandomValues(new Uint8Array(32)))
          if (byte < limit && out.length < 14) out += alphabet[byte % alphabet.length];
      if (/[a-z]/i.test(out) && /[2-9]/.test(out)) return out;
    }
  }

  window.DX = {
    esc,
    api,
    toast,
    modal,
    confirmBox,
    copy,
    badge,
    fmtDate,
    debounce,
    generatePassword,
  };
})();
