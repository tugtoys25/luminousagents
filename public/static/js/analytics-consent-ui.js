/* global document, window, localStorage, CustomEvent */
(() => {
  const banner = document.querySelector('#analytics-consent');
  if (!banner) return;
  const KEY = 'mayfair_analytics_consent';
  const AT = KEY + '_at';
  const days = Number(banner.dataset.days) || 180;
  const ga = banner.dataset.ga4 || '';

  function read() {
    try {
      const value = localStorage.getItem(KEY) || '';
      const at = Number(localStorage.getItem(AT) || 0);
      if (value && at && Date.now() - at > days * 86400000) return '';
      return value;
    } catch {
      return '';
    }
  }
  function store(value) {
    try {
      localStorage.setItem(KEY, value);
      localStorage.setItem(AT, String(Date.now()));
    } catch {
      /* storage unavailable: choice applies to this page view only */
    }
  }
  function clearAnalyticsCookies() {
    const host = window.location.hostname;
    const parts = host.split('.');
    const domains = ['', host, '.' + host];
    if (parts.length > 2) domains.push('.' + parts.slice(-2).join('.'));
    document.cookie.split(';').forEach((cookie) => {
      const name = cookie.split('=')[0].trim();
      if (!/^_ga|^_gid|^_gat/.test(name)) return;
      domains.forEach((domain) => {
        document.cookie =
          name +
          '=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/' +
          (domain ? '; domain=' + domain : '');
      });
    });
  }
  function show(focus) {
    banner.hidden = false;
    if (focus) {
      const first = banner.querySelector('button');
      if (first) first.focus();
    }
  }

  if (!read()) show(false);

  banner.querySelectorAll('[data-consent]').forEach((button) =>
    button.addEventListener('click', () => {
      const accepted = button.dataset.consent === 'accept';
      store(accepted ? 'accepted' : 'rejected');
      banner.hidden = true;
      if (accepted) {
        if (ga) window['ga-disable-' + ga] = false;
        window.dispatchEvent(new CustomEvent('mayfair:analytics-consent', { detail: 'accepted' }));
      } else {
        if (ga) window['ga-disable-' + ga] = true;
        clearAnalyticsCookies();
      }
    }),
  );

  document.querySelectorAll('[data-cookie-settings]').forEach((link) =>
    link.addEventListener('click', (event) => {
      event.preventDefault();
      show(true);
    }),
  );
})();
