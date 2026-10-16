/* Renders the Cloudflare Turnstile widget inside every <form data-turnstile>.
 * The widget adds a hidden "cf-turnstile-response" input, which the existing form scripts
 * already send with the rest of the fields. The server verifies it (src/security/turnstile.ts). */
(() => {
  if (window.__mayfairTurnstileLoaded) return;
  window.__mayfairTurnstileLoaded = true;
  const forms = Array.from(document.querySelectorAll('form[data-turnstile]'));
  if (!forms.length) return;

  window.mayfairResetTurnstile = (form) => {
    const id = form && form.dataset.turnstileWidget;
    if (id !== undefined && id !== '' && window.turnstile) window.turnstile.reset(id);
  };

  fetch('/api/public/turnstile', { credentials: 'same-origin' })
    .then((response) => (response.ok ? response.json() : null))
    .then((config) => {
      const siteKey = config && config.data && config.data.siteKey;
      if (!siteKey) return;
      const script = document.createElement('script');
      script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
      script.async = true;
      script.defer = true;
      script.onload = () => {
        forms.forEach((form) => {
          const box = document.createElement('div');
          box.className = 'turnstile-widget';
          const submit = form.querySelector('button[type="submit"]');
          form.insertBefore(box, submit);
          form.dataset.turnstileWidget = String(
            window.turnstile.render(box, { sitekey: siteKey, theme: 'auto' }),
          );
        });
      };
      document.head.appendChild(script);
    })
    .catch(() => {
      /* Without the widget the server rejects the submission; nothing is bypassed. */
    });
})();
