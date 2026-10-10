(() => {
  const banner = document.querySelector('#analytics-consent');
  if (!banner) return;
  let choice = '';
  try {
    choice = localStorage.getItem('mayfair_analytics_consent') || '';
  } catch {}
  if (!choice) banner.hidden = false;
  banner.querySelectorAll('[data-consent]').forEach((button) =>
    button.addEventListener('click', () => {
      const value = button.dataset.consent === 'accept' ? 'accepted' : 'rejected';
      try {
        localStorage.setItem('mayfair_analytics_consent', value);
      } catch {}
      banner.hidden = true;
      if (value === 'accepted')
        window.dispatchEvent(new CustomEvent('mayfair:analytics-consent', { detail: value }));
    }),
  );
})();
