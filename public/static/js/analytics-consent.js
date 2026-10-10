/* global document, window, localStorage */
(() => {
  const current = document.currentScript;
  const id = current?.dataset.ga4;
  if (!id || !/^G-[A-Z0-9]+$/.test(id)) return;
  const days = Number(current.dataset.days) || 180;
  function enable() {
    if (window.__mayfairAnalyticsLoaded) return;
    window.__mayfairAnalyticsLoaded = true;
    const s = document.createElement('script');
    s.async = true;
    s.src = 'https://www.googletagmanager.com/gtag/js?id=' + encodeURIComponent(id);
    document.head.appendChild(s);
    window.dataLayer = window.dataLayer || [];
    window.gtag = function () {
      window.dataLayer.push(arguments);
    };
    window.gtag('js', new Date());
    window.gtag('config', id);
  }
  try {
    const at = Number(localStorage.getItem('mayfair_analytics_consent_at') || 0);
    const fresh = !at || Date.now() - at <= days * 86400000;
    if (localStorage.getItem('mayfair_analytics_consent') === 'accepted' && fresh) enable();
  } catch {
    /* storage unavailable: analytics stays off */
  }
  window.addEventListener('mayfair:analytics-consent', (e) => {
    if (e.detail === 'accepted') enable();
  });
})();
