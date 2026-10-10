/* Accessible progressive enhancement for the public enquiry form. */
(() => {
  const form = document.querySelector('form.contact-form');
  if (!form) return;
  const message = form.querySelector('textarea[name="message"]');
  if (message) {
    const counter = document.createElement('p');
    counter.className = 'contact-counter';
    counter.setAttribute('aria-live', 'polite');
    counter.textContent = `${message.value.length} / ${message.maxLength} characters`;
    message.insertAdjacentElement('afterend', counter);
    message.addEventListener('input', () => {
      counter.textContent = `${message.value.length} / ${message.maxLength} characters`;
    });
  }
  form.addEventListener('submit', (event) => {
    if (!form.checkValidity()) {
      event.preventDefault();
      form.reportValidity();
      return;
    }
    const button = form.querySelector('button[type="submit"]');
    if (button) {
      button.disabled = true;
      button.setAttribute('aria-busy', 'true');
      button.dataset.originalText = button.textContent || '';
      button.textContent = 'Sending enquiry…';
    }
  });
})();
