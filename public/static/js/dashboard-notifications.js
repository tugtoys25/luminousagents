(() => {
  const root = document.querySelector('#jobs');
  const notice = document.querySelector('#notice');
  const el = (tag, text, cls) => {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    if (cls) node.className = cls;
    return node;
  };
  async function api(path, options = {}) {
    const response = await fetch(path, {
      credentials: 'same-origin',
      ...options,
      headers: {
        ...(options.body ? { 'Content-Type': 'application/json' } : {}),
        ...(options.headers || {}),
      },
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body?.error?.message || 'Request failed');
    return body.data;
  }
  async function load() {
    try {
      const jobs = await api('/dashboard/notifications/jobs');
      root.replaceChildren();
      if (!jobs.length) {
        root.append(el('p', 'No notification jobs yet.'));
        return;
      }
      for (const job of jobs) {
        const card = el('article', undefined, 'job');
        card.append(
          el('h2', job.jobType),
          el('p', `Status: ${job.status} · Attempts: ${job.attempts}`),
          el(
            'p',
            `Created: ${new Date(job.createdAt).toLocaleString()} · Last update: ${new Date(job.updatedAt).toLocaleString()}`,
            'muted',
          ),
        );
        if (job.status === 'queued' || job.status === 'dead' || job.status === 'failed') {
          const form = el('form');
          const button = el('button', 'Retry delivery');
          button.type = 'submit';
          form.append(button);
          form.addEventListener('submit', async (event) => {
            event.preventDefault();
            try {
              await api(`/dashboard/notifications/jobs/${encodeURIComponent(job.id)}/retry`, {
                method: 'POST',
                body: '{}',
              });
              notice.textContent = 'Retry queued.';
              await load();
            } catch (error) {
              notice.textContent = error.message;
            }
          });
          card.append(form);
        }
        root.append(card);
      }
    } catch (error) {
      root.replaceChildren(el('p', error.message));
    }
  }
  load();
})();
