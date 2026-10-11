(() => {
  const { esc, api, toast, badge, fmtDate, debounce, confirmBox } = window.DX;
  const listView = document.getElementById('pages-list-view');
  const editorView = document.getElementById('pages-editor-view');
  const table = document.getElementById('pg-table');
  const tabs = document.getElementById('pg-tabs');
  const search = document.getElementById('pg-search');
  const form = document.getElementById('pg-form');
  const heading = document.getElementById('pg-heading');
  const urlBox = document.getElementById('pg-url');
  const urlNote = document.getElementById('pg-url-note');
  const viewLink = document.getElementById('pg-view');
  const slugInput = document.getElementById('pg-slug');
  let defaults = [];
  let customs = [];
  let tab = 'all';
  let editing = null; // { builtin: bool, path, record }

  const slugify = (v) =>
    v
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 100);

  function buildRows() {
    const rows = defaults.map((d) => {
      const record = customs.find((p) => p.slug === d.slug) || null;
      return {
        kind: 'builtin',
        key: d.slug,
        title: record?.title || d.title,
        path: d.path,
        status: record ? record.status : 'default',
        updatedAt: record?.updatedAt || '',
        record,
        def: d,
      };
    });
    for (const p of customs.filter((c) => !c.isBuiltin))
      rows.push({
        kind: 'custom',
        key: p.slug,
        title: p.title,
        path: p.publicPath,
        status: p.status,
        updatedAt: p.updatedAt,
        record: p,
      });
    return rows;
  }

  function statusBadge(r) {
    if (r.status === 'default') return badge('Default text', 'info');
    if (r.status === 'published')
      return badge(r.kind === 'builtin' ? 'Customised' : 'Published', 'ok');
    if (r.status === 'draft') return badge(r.kind === 'builtin' ? 'Draft copy' : 'Draft', 'warn');
    return badge('Archived', 'muted');
  }

  function visible(rows) {
    const q = (search.value || '').trim().toLowerCase();
    return rows.filter(
      (r) =>
        (tab === 'all' ||
          (tab === 'builtin' && r.kind === 'builtin') ||
          (tab === 'custom' && r.kind === 'custom') ||
          (tab === 'draft' && r.status === 'draft')) &&
        (!q || `${r.title} ${r.path}`.toLowerCase().includes(q)),
    );
  }

  function render() {
    const rows = buildRows();
    const counts = {
      all: rows.length,
      builtin: rows.filter((r) => r.kind === 'builtin').length,
      custom: rows.filter((r) => r.kind === 'custom').length,
      draft: rows.filter((r) => r.status === 'draft').length,
    };
    tabs.querySelectorAll('.dx-tab').forEach((b) => {
      b.setAttribute('aria-selected', String(b.dataset.tab === tab));
      b.querySelector('.dx-count').textContent = counts[b.dataset.tab];
    });
    const items = visible(rows);
    table.innerHTML = items.length
      ? `<table class="dx-table"><thead><tr><th>Page</th><th>Address</th><th>Type</th><th>Status</th><th>Updated</th><th></th></tr></thead><tbody>${items
          .map((r) => {
            const k = esc(r.key);
            const live =
              r.status === 'published' || (r.kind === 'builtin' && r.status === 'default');
            const toggle = r.record
              ? r.record.status === 'published'
                ? `<button class="dx-btn dx-btn-sm" data-act="unpublish" data-key="${k}">Unpublish</button>`
                : `<button class="dx-btn dx-btn-sm" data-act="publish" data-key="${k}">Publish</button>`
              : '';
            const remove = r.record
              ? `<button class="dx-btn dx-btn-sm dx-btn-ghost-danger" data-act="remove" data-key="${k}">${r.kind === 'builtin' ? 'Reset' : 'Delete'}</button>`
              : '';
            return `<tr><td><span class="dx-primary">${esc(r.title)}</span></td><td><code>${esc(r.path)}</code></td><td>${badge(r.kind === 'builtin' ? 'Built-in' : 'My page', r.kind === 'builtin' ? 'info' : 'muted')}</td><td>${statusBadge(r)}</td><td>${r.updatedAt ? fmtDate(r.updatedAt) : '–'}</td><td><div class="dx-row-actions"><button class="dx-btn dx-btn-sm dx-btn-primary" data-act="edit" data-key="${k}">${r.kind === 'builtin' && !r.record ? 'Customise' : 'Edit'}</button>${live ? `<a class="dx-btn dx-btn-sm" href="${esc(r.path)}" target="_blank" rel="noopener">View</a>` : ''}${toggle}${remove}</div></td></tr>`;
          })
          .join('')}</tbody></table>`
      : '<div class="dx-empty">No pages match.</div>';
  }

  async function load() {
    try {
      const [d, c] = await Promise.all([api('/dashboard/pages/defaults'), api('/dashboard/pages')]);
      defaults = d;
      customs = c;
      render();
    } catch (e) {
      table.innerHTML = `<div class="dx-empty">${esc(e.message)}</div>`;
    }
  }

  /* ----- editor view ----- */
  function showList() {
    editorView.hidden = true;
    listView.hidden = false;
    editing = null;
    if (location.hash) history.replaceState(null, '', location.pathname);
    window.scrollTo({ top: 0 });
  }

  function openEditor(row) {
    editing = row;
    const builtin = row?.kind === 'builtin';
    form.reset();
    const rec = row?.record;
    const src = rec || row?.def || {};
    form.elements.id.value = rec?.id || '';
    form.elements.title.value = src.title || '';
    form.elements.bodyMarkdown.value = rec?.bodyMarkdown ?? row?.def?.bodyMarkdown ?? '';
    form.elements.description.value = src.description || '';
    form.elements.seoTitle.value = rec?.seoTitle || '';
    form.elements.seoDescription.value = rec?.seoDescription || '';
    form.elements.status.value = rec ? rec.status : builtin ? 'published' : 'draft';
    slugInput.value = row ? row.key : '';
    slugInput.readOnly = Boolean(builtin || rec);
    slugInput.hidden = true;
    heading.textContent = row
      ? builtin && !rec
        ? `Customise: ${row.title}`
        : `Edit: ${row.title}`
      : 'New page';
    if (builtin) {
      urlBox.textContent = row.path;
      urlNote.textContent = 'Built-in page: the address stays the same, only the text changes.';
    } else if (rec) {
      urlBox.textContent = row.path;
      urlNote.textContent = 'The address of a saved page does not change.';
    } else {
      slugInput.hidden = false;
      slugInput.readOnly = false;
      urlBox.textContent = '/pages/…';
      urlNote.textContent = 'Generated from the title. You can edit it before the first save.';
    }
    viewLink.hidden = !row || (!rec && !builtin) || (rec && rec.status !== 'published' && !builtin);
    if (!viewLink.hidden) viewLink.href = row.path;
    listView.hidden = true;
    editorView.hidden = false;
    history.replaceState(null, '', row ? `#edit/${row.key}` : '#new');
    window.scrollTo({ top: 0 });
    form.elements.title.focus();
  }

  form.elements.title.addEventListener('input', () => {
    if (editing || slugInput.readOnly) return;
    slugInput.value = slugify(form.elements.title.value);
    urlBox.textContent = `/pages/${slugInput.value || '…'}`;
  });
  slugInput.addEventListener('input', () => {
    urlBox.textContent = `/pages/${slugInput.value || '…'}`;
  });

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(form));
    if (!data.id) delete data.id;
    try {
      const saved = await api('/dashboard/pages', 'POST', data);
      toast(
        saved.status === 'published'
          ? `Saved and live at ${saved.publicPath}`
          : 'Saved. The page is not public until it is published.',
      );
      await load();
      showList();
    } catch (e) {
      toast(e.message, 'error');
    }
  });

  /* ----- list actions ----- */
  table.addEventListener('click', async (event) => {
    const b = event.target.closest('[data-act]');
    if (!b) return;
    const row = buildRows().find((r) => r.key === b.dataset.key);
    if (!row) return;
    const act = b.dataset.act;
    if (act === 'edit') return openEditor(row);
    try {
      if (act === 'publish' || act === 'unpublish') {
        await api(`/dashboard/pages/${row.record.id}/status`, 'PATCH', {
          status: act === 'publish' ? 'published' : 'draft',
        });
        toast(act === 'publish' ? 'Page published.' : 'Page unpublished.');
      } else if (act === 'remove') {
        const builtin = row.kind === 'builtin';
        const ok = await confirmBox({
          title: builtin ? 'Reset to default text?' : 'Delete this page?',
          message: builtin
            ? `Your customised text for ${row.path} will be removed and the original default text returns. The address does not change.`
            : `${row.title} will be removed permanently.`,
          confirmLabel: builtin ? 'Reset page' : 'Delete page',
          danger: true,
        });
        if (!ok) return;
        await api(`/dashboard/pages/${row.record.id}`, 'DELETE');
        toast(builtin ? 'Page reset to default.' : 'Page deleted.');
      }
      await load();
    } catch (e) {
      toast(e.message, 'error');
    }
  });
  tabs.addEventListener('click', (event) => {
    const b = event.target.closest('.dx-tab');
    if (!b) return;
    tab = b.dataset.tab;
    render();
  });
  search.addEventListener('input', debounce(render, 120));
  document.getElementById('pg-new').addEventListener('click', () => openEditor(null));
  document.getElementById('pg-back').addEventListener('click', showList);

  load().then(() => {
    const m = location.hash.match(/^#edit\/(.+)$/);
    if (m) {
      const row = buildRows().find((r) => r.key === decodeURIComponent(m[1]));
      if (row) openEditor(row);
    } else if (location.hash === '#new') openEditor(null);
  });
})();
