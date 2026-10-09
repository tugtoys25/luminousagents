(() => {
  const list = document.querySelector('#task-list');
  const notice = document.querySelector('#task-notice');
  const form = document.querySelector('#task-create');
  const statuses = ['open', 'in_progress', 'blocked', 'done', 'cancelled'];
  const priorities = ['low', 'normal', 'high', 'urgent'];
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
    list.replaceChildren(el('p', 'Loading tasks…'));
    try {
      const tasks = await api('/dashboard/tasks');
      list.replaceChildren();
      if (!tasks.length) {
        list.append(el('p', 'No tasks yet.'));
        return;
      }
      for (const task of tasks) {
        const card = el('article', undefined, 'task');
        const header = el('header');
        header.append(
          el('h2', task.title),
          el('span', `${task.priority.toUpperCase()} · ${task.status.replace('_', ' ')}`),
        );
        card.append(header);
        if (task.description) card.append(el('p', task.description));
        card.append(
          el(
            'p',
            `Assignee: ${task.assigneeName || task.assigneeEmail || task.assignedTo || 'Unassigned'} · Due: ${task.dueAt ? new Date(task.dueAt).toLocaleString() : 'No due date'}`,
            'muted',
          ),
        );
        const edit = el('form');
        const status = el('select');
        status.setAttribute('aria-label', `Status for ${task.title}`);
        statuses.forEach((value) => {
          const option = el('option', value.replace('_', ' '));
          option.value = value;
          option.selected = value === task.status;
          status.append(option);
        });
        const priority = el('select');
        priority.setAttribute('aria-label', `Priority for ${task.title}`);
        priorities.forEach((value) => {
          const option = el('option', value);
          option.value = value;
          option.selected = value === task.priority;
          priority.append(option);
        });
        const save = el('button', 'Save changes');
        save.type = 'submit';
        edit.append(status, priority, save);
        edit.addEventListener('submit', async (event) => {
          event.preventDefault();
          try {
            await api(`/dashboard/tasks/${encodeURIComponent(task.id)}`, {
              method: 'PATCH',
              body: JSON.stringify({ status: status.value, priority: priority.value }),
            });
            notice.textContent = 'Task updated.';
            await load();
          } catch (error) {
            notice.textContent = error.message;
          }
        });
        card.append(edit);
        list.append(card);
      }
    } catch (error) {
      list.replaceChildren(el('p', error.message));
    }
  }
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const data = new FormData(form);
    const payload = {
      title: String(data.get('title') || ''),
      description: String(data.get('description') || ''),
      priority: String(data.get('priority') || 'normal'),
    };
    const dueAt = String(data.get('dueAt') || '');
    const assignedTo = String(data.get('assignedTo') || '').trim();
    if (dueAt) payload.dueAt = new Date(dueAt).toISOString();
    if (assignedTo) payload.assignedTo = assignedTo;
    try {
      await api('/dashboard/tasks', { method: 'POST', body: JSON.stringify(payload) });
      form.reset();
      notice.textContent = 'Task created.';
      await load();
    } catch (error) {
      notice.textContent = error.message;
    }
  });
  load();
})();
