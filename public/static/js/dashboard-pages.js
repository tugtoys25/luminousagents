(() => {
  const f = document.querySelector('#managed-page-form');
  if (!f) return;
  const list = document.querySelector('#managed-pages'),
    notice = document.querySelector('#page-notice'),
    heading = document.querySelector('#page-form-title'),
    fields = [
      'id',
      'title',
      'slug',
      'description',
      'bodyMarkdown',
      'seoTitle',
      'seoDescription',
      'status',
    ];
  const tone = (status) =>
    status === 'published' ? 'ok' : status === 'archived' ? 'danger' : 'warn';
  const say = (message) => {
    notice.textContent = message;
  };
  function startNew() {
    f.reset();
    f.elements.id.value = '';
    heading.textContent = 'New page';
    say('');
  }
  function edit(p) {
    for (const k of fields) f.elements[k].value = p[k] ?? '';
    heading.textContent = `Edit: ${p.title}`;
    for (const row of list.querySelectorAll('.page-row'))
      row.toggleAttribute('data-current', row.dataset.id === p.id);
    f.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }
  const builtin = document.querySelector('#builtin-pages');
  async function loadBuiltin(existing) {
    if (!builtin) return;
    try {
      const r = await fetch('/dashboard/pages/defaults');
      const j = await r.json();
      builtin.replaceChildren();
      for (const d of j.data || []) {
        const current = existing.find((p) => p.slug === d.slug);
        const li = document.createElement('li');
        const row = document.createElement('div');
        row.className = 'page-row';
        const top = document.createElement('div');
        top.className = 'page-row-top';
        const name = document.createElement('span');
        name.className = 'row-title';
        name.textContent = d.title;
        const state = document.createElement('span');
        state.className = `ws-badge ws-badge--${current ? tone(current.status) : 'info'}`;
        state.textContent = current
          ? current.status === 'published'
            ? 'customised'
            : `${current.status} copy`
          : 'default text';
        top.append(name, state);
        const meta = document.createElement('span');
        meta.className = 'row-meta';
        meta.textContent = d.path;
        const actions = document.createElement('div');
        actions.className = 'page-row-actions';
        const b = document.createElement('button');
        b.type = 'button';
        b.textContent = current ? 'Edit' : 'Customise';
        b.onclick = () => {
          if (current) return edit(current);
          f.reset();
          f.elements.id.value = '';
          for (const k of ['title', 'slug', 'description', 'bodyMarkdown'])
            f.elements[k].value = d[k] ?? '';
          f.elements.status.value = 'draft';
          heading.textContent = `Customise: ${d.title}`;
          say(
            'Edit the text, set Status to Published and save to replace the default on the public site.',
          );
          f.scrollIntoView({ block: 'start', behavior: 'smooth' });
        };
        const a = document.createElement('a');
        a.href = d.path;
        a.className = 'ws-btn';
        a.target = '_blank';
        a.rel = 'noopener';
        a.textContent = 'View';
        actions.append(b, a);
        row.append(top, meta, actions);
        li.append(row);
        builtin.append(li);
      }
    } catch {
      builtin.textContent = 'Unable to load built-in pages.';
    }
  }
  async function load() {
    try {
      const r = await fetch('/dashboard/pages');
      const j = await r.json();
      loadBuiltin(j.data || []);
      list.replaceChildren();
      for (const p of j.data || []) {
        const li = document.createElement('li');
        const row = document.createElement('div');
        row.className = 'page-row';
        row.dataset.id = p.id;
        const top = document.createElement('div');
        top.className = 'page-row-top';
        const name = document.createElement('span');
        name.className = 'row-title';
        name.textContent = p.title;
        const status = document.createElement('span');
        status.className = `ws-badge ws-badge--${tone(p.status)}`;
        status.textContent = p.status;
        top.append(name, status);
        const meta = document.createElement('span');
        meta.className = 'row-meta';
        meta.textContent = `/pages/${p.slug}`;
        const actions = document.createElement('div');
        actions.className = 'page-row-actions';
        const b = document.createElement('button');
        b.type = 'button';
        b.textContent = 'Edit';
        b.onclick = () => edit(p);
        const a = document.createElement('a');
        a.href = '/pages/' + encodeURIComponent(p.slug);
        a.className = 'ws-btn';
        a.target = '_blank';
        a.rel = 'noopener';
        a.textContent = 'View';
        actions.append(b, a);
        row.append(top, meta, actions);
        li.append(row);
        list.append(li);
      }
      if (!list.children.length) {
        const li = document.createElement('li');
        li.className = 'empty-state';
        li.textContent = 'No pages yet. Fill in the form to create the first one.';
        list.append(li);
      }
    } catch {
      list.textContent = 'Unable to load pages.';
    }
  }
  document.querySelector('#page-new')?.addEventListener('click', startNew);
  f.addEventListener('submit', async (e) => {
    e.preventDefault();
    const d = Object.fromEntries(new FormData(f));
    say('Saving…');
    try {
      const r = await fetch('/dashboard/pages', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(d),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error?.message || 'Could not save page');
      say(`Saved. Public URL: /pages/${j.data.slug}`);
      f.elements.id.value = j.data.id;
      heading.textContent = `Edit: ${d.title}`;
      await load();
    } catch (err) {
      say(err.message || 'Could not save page');
    }
  });
  load();
})();
