(() => {
  const { esc, toast, modal, confirmBox, badge, debounce } = window.DX;
  const root = document.querySelector('main.admin');
  const role = root.dataset.role;
  const isPublisher = ['admin', 'publisher', 'super_admin'].includes(role);
  const isAdmin = ['admin', 'super_admin'].includes(role);

  const $ = (id) => document.getElementById(id);
  const listView = $('op-list-view');
  const editorView = $('op-editor-view');
  const table = $('op-table');
  const pager = $('op-pager');
  const tabs = $('op-tabs');
  const search = $('op-search');
  const form = $('op-form');
  const bulkBar = $('op-bulk');

  const state = {
    stage: 'all',
    page: 1,
    pageSize: 25,
    total: 0,
    counts: {},
    rows: [],
    picked: new Set(),
  };
  let current = null; // opportunity being edited (raw API row) or null for new
  let brokersLoaded = false;

  /* ---------- network ---------- */
  async function call(url, options = {}) {
    const isForm = options.body instanceof FormData;
    const response = await fetch(url, {
      credentials: 'same-origin',
      ...options,
      headers: {
        ...(options.body && !isForm ? { 'content-type': 'application/json' } : {}),
        ...(options.headers || {}),
      },
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(payload?.error?.message || `Request failed (${response.status})`);
      error.code = payload?.error?.code;
      throw error;
    }
    return payload;
  }
  const json = (method, body) => ({ method, body: JSON.stringify(body) });

  /* ---------- stage helpers ---------- */
  function stageOf(o) {
    const lifecycle = o.lifecycle;
    const review = o.reviewStatus ?? o.content_review_status;
    const visible = (o.publicVisibility ?? o.public_visibility) === 1;
    if (lifecycle === 'published' && visible) return 'live';
    if (['sold', 'off_market', 'archived', 'on_hold', 'under_offer'].includes(lifecycle))
      return 'closed';
    if (review === 'approved') return 'ready';
    if (lifecycle === 'in_review') return 'review';
    return 'draft';
  }
  const stageBadge = (o) => {
    const stage = o.stage || stageOf(o);
    if (stage === 'live') return badge('Live', 'ok');
    if (stage === 'ready') return badge('Approved - ready to publish', 'info');
    if (stage === 'review') return badge('In review', 'warn');
    if (stage === 'closed') return badge(String(o.lifecycle).replace('_', ' '), 'muted');
    return badge('Draft', 'muted');
  };

  /* ---------- workflow actions (one place, used by table and editor) ---------- */
  async function act(id, action, extra = {}) {
    try {
      const r = await call(
        `/dashboard/opportunities/${encodeURIComponent(id)}/workflow`,
        json('POST', { action, ...extra }),
      );
      return r.data;
    } catch (error) {
      if (error.code === 'NOT_PUBLIC' && action === 'publish') {
        const ok = await confirmBox({
          title: 'Make this listing public?',
          message: `${error.message} Publish it anyway?`,
          confirmLabel: 'Publish as public',
        });
        if (!ok) return null;
        return act(id, 'publish', { makePublic: true });
      }
      toast(error.message, 'error');
      return null;
    }
  }
  const ACTION_DONE = {
    submit: 'Sent for review.',
    approve: 'Approved. It is ready to publish.',
    unapprove: 'Approval removed.',
    publish: 'Published. It is now live on the website.',
    unpublish: 'Unpublished. It is no longer visible on the website.',
    archive: 'Archived.',
    restore: 'Restored.',
  };
  async function runAndRefresh(id, action) {
    const result = await act(id, action);
    if (!result) return false;
    toast(ACTION_DONE[action]);
    await loadList();
    if (current && current.id === id) await openEditor(id, true);
    return true;
  }

  /* ---------- list ---------- */
  function rowActions(o) {
    const id = esc(o.id);
    const stage = o.stage;
    const buttons = [`<a class="dx-btn dx-btn-sm dx-btn-primary" href="#edit/${id}">Edit</a>`];
    if (stage === 'live')
      buttons.push(
        `<a class="dx-btn dx-btn-sm" href="/opportunities/${encodeURIComponent(o.slug)}" target="_blank" rel="noopener">View</a>`,
      );
    if (isPublisher) {
      if (stage === 'closed') {
        buttons.push(
          `<button class="dx-btn dx-btn-sm" data-act="restore" data-id="${id}">Restore</button>`,
        );
      } else {
        buttons.push(
          o.reviewStatus === 'approved'
            ? `<button class="dx-btn dx-btn-sm" data-act="unapprove" data-id="${id}">Unapprove</button>`
            : `<button class="dx-btn dx-btn-sm" data-act="approve" data-id="${id}">Approve</button>`,
        );
        buttons.push(
          stage === 'live'
            ? `<button class="dx-btn dx-btn-sm" data-act="unpublish" data-id="${id}">Unpublish</button>`
            : `<button class="dx-btn dx-btn-sm" data-act="publish" data-id="${id}"${o.reviewStatus === 'approved' ? '' : ' disabled title="Approve it first"'}>Publish</button>`,
        );
      }
      buttons.push(
        isAdmin
          ? `<button class="dx-btn dx-btn-sm dx-btn-ghost-danger" data-act="delete" data-id="${id}">Delete</button>`
          : stage === 'closed'
            ? ''
            : `<button class="dx-btn dx-btn-sm dx-btn-ghost-danger" data-act="archive" data-id="${id}">Archive</button>`,
      );
    } else if (stage === 'draft') {
      buttons.push(
        `<button class="dx-btn dx-btn-sm" data-act="submit" data-id="${id}">Send for review</button>`,
      );
    }
    return `<div class="dx-row-actions">${buttons.join('')}</div>`;
  }

  function renderTable() {
    const columns = isPublisher ? 7 : 6;
    if (!state.rows.length) {
      table.innerHTML =
        '<div class="dx-empty">No opportunities match. Try another tab or search.</div>';
    } else {
      table.innerHTML = `<table class="dx-table"><thead><tr>${
        isPublisher
          ? '<th class="dx-col-check"><input type="checkbox" id="op-pick-all" aria-label="Select all on this page"></th>'
          : ''
      }<th>Opportunity</th><th>Price</th><th>Status</th><th>Updated</th><th></th></tr></thead><tbody>${state.rows
        .map(
          (o) =>
            `<tr>${
              isPublisher
                ? `<td class="dx-col-check"><input type="checkbox" data-pick="${esc(o.id)}" ${state.picked.has(o.id) ? 'checked' : ''} aria-label="Select ${esc(o.title)}"></td>`
                : ''
            }<td><a class="dx-primary" href="#edit/${esc(o.id)}">${esc(o.title)}</a><span class="dx-secondary">${esc(o.country || 'No country')} · ${esc(String(o.opportunityType).replace('-', ' '))}</span></td><td>${esc(o.priceText || '–')}</td><td>${stageBadge(o)}</td><td>${window.DX.fmtDate(o.updatedAt)}</td><td>${rowActions(o)}</td></tr>`,
        )
        .join('')}</tbody></table>`;
    }
    void columns;
    const pages = Math.max(1, Math.ceil(state.total / state.pageSize));
    const from = state.total ? (state.page - 1) * state.pageSize + 1 : 0;
    const to = Math.min(state.total, state.page * state.pageSize);
    pager.innerHTML = state.total
      ? `<span>Showing ${from}–${to} of ${state.total}</span><span class="dx-spacer"></span><button class="dx-btn dx-btn-sm" data-page="${state.page - 1}" ${state.page <= 1 ? 'disabled' : ''}>← Previous</button><span>Page ${state.page} of ${pages}</span><button class="dx-btn dx-btn-sm" data-page="${state.page + 1}" ${state.page >= pages ? 'disabled' : ''}>Next →</button>`
      : '';
    tabs.querySelectorAll('.dx-tab').forEach((b) => {
      b.setAttribute('aria-selected', String(b.dataset.tab === state.stage));
      b.querySelector('.dx-count').textContent = state.counts[b.dataset.tab] ?? 0;
    });
    updateBulk();
  }

  function updateBulk() {
    if (!bulkBar) return;
    const n = state.picked.size;
    bulkBar.hidden = n === 0;
    $('op-bulk-count').textContent = `${n} selected`;
  }

  async function loadList() {
    const params = new URLSearchParams({
      q: search.value.trim(),
      page: String(state.page),
      pageSize: String(state.pageSize),
    });
    if (state.stage !== 'all') params.set('stage', state.stage);
    try {
      const r = await call(`/dashboard/opportunities?${params}`);
      state.rows = r.data;
      state.total = r.total;
      state.counts = r.counts;
      renderTable();
    } catch (error) {
      table.innerHTML = `<div class="dx-empty">${esc(error.message)}</div>`;
    }
  }

  table.addEventListener('click', async (event) => {
    const b = event.target.closest('[data-act]');
    if (!b) return;
    const row = state.rows.find((r) => r.id === b.dataset.id);
    if (!row) return;
    const action = b.dataset.act;
    if (action === 'delete') {
      const ok = await confirmBox({
        title: 'Delete this opportunity?',
        message: `${row.title} will be removed permanently. If it has NDA requests or documents it cannot be deleted and you can archive it instead.`,
        confirmLabel: 'Delete',
        danger: true,
      });
      if (!ok) return;
      try {
        await call(`/dashboard/opportunities/${encodeURIComponent(row.id)}`, { method: 'DELETE' });
        toast('Opportunity deleted.');
        await loadList();
      } catch (error) {
        if (error.code === 'HAS_RECORDS') {
          const archive = await confirmBox({
            title: 'It cannot be deleted',
            message: `${error.message} Archive it now?`,
            confirmLabel: 'Archive',
          });
          if (archive) await runAndRefresh(row.id, 'archive');
        } else toast(error.message, 'error');
      }
      return;
    }
    if (action === 'unapprove' || action === 'unpublish') {
      if (row.stage === 'live') {
        const ok = await confirmBox({
          title: action === 'unpublish' ? 'Unpublish this listing?' : 'Remove approval?',
          message: 'It will disappear from the website until it is approved and published again.',
          confirmLabel: action === 'unpublish' ? 'Unpublish' : 'Remove approval',
          danger: true,
        });
        if (!ok) return;
      }
    }
    if (action === 'archive') {
      const ok = await confirmBox({
        title: 'Archive this listing?',
        message: 'It is hidden everywhere. An administrator can restore it later.',
        confirmLabel: 'Archive',
        danger: true,
      });
      if (!ok) return;
    }
    await runAndRefresh(row.id, action);
  });

  table.addEventListener('change', (event) => {
    const all = event.target.closest('#op-pick-all');
    if (all) {
      table.querySelectorAll('[data-pick]').forEach((box) => {
        box.checked = all.checked;
        if (all.checked) state.picked.add(box.dataset.pick);
        else state.picked.delete(box.dataset.pick);
      });
      return updateBulk();
    }
    const box = event.target.closest('[data-pick]');
    if (box) {
      if (box.checked) state.picked.add(box.dataset.pick);
      else state.picked.delete(box.dataset.pick);
      updateBulk();
    }
  });
  pager.addEventListener('click', (event) => {
    const b = event.target.closest('[data-page]');
    if (!b || b.disabled) return;
    state.page = Number(b.dataset.page);
    loadList();
    window.scrollTo({ top: 0 });
  });
  tabs.addEventListener('click', (event) => {
    const b = event.target.closest('.dx-tab');
    if (!b) return;
    state.stage = b.dataset.tab;
    state.page = 1;
    loadList();
  });
  search.addEventListener(
    'input',
    debounce(() => {
      state.page = 1;
      loadList();
    }, 300),
  );

  bulkBar?.addEventListener('click', (event) => {
    const b = event.target.closest('[data-bulk]');
    if (!b) return;
    if (b.dataset.bulk === 'clear') {
      state.picked.clear();
      return renderTable();
    }
    const decision = b.dataset.bulk;
    const ids = [...state.picked].slice(0, 50);
    const dlg = modal(
      `${decision === 'approved' ? 'Approve' : 'Reject'} ${ids.length} listing${ids.length === 1 ? '' : 's'}`,
      `<form class="dx-form" id="bulk-form"><label class="dx-field">Reason (kept in the audit log)<textarea name="reason" minlength="3" maxlength="500" required></textarea></label><div class="dx-note">Bulk review never publishes anything. Approved listings still need Publish.</div><div class="dx-actions"><button type="button" class="dx-btn" data-close>Cancel</button><button type="submit" class="dx-btn ${decision === 'approved' ? 'dx-btn-primary' : 'dx-btn-danger'}">Confirm</button></div></form>`,
    );
    dlg.el.querySelector('#bulk-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        const r = await call(
          '/dashboard/opportunities/bulk-review',
          json('POST', { ids, decision, reason: new FormData(e.currentTarget).get('reason') }),
        );
        state.picked.clear();
        dlg.close();
        toast(`${r.data.processed} listing${r.data.processed === 1 ? '' : 's'} ${decision}.`);
        await loadList();
      } catch (error) {
        toast(error.message, 'error');
      }
    });
  });

  const importFile = $('op-import-file');
  $('op-import')?.addEventListener('click', () => importFile.click());
  importFile?.addEventListener('change', async () => {
    const file = importFile.files?.[0];
    if (!file) return;
    if (file.size > 1_000_000) return toast('CSV import is limited to 1 MB.', 'error');
    const ok = await confirmBox({
      title: 'Import updates?',
      message: 'Every imported listing becomes a private draft and needs fresh review.',
      confirmLabel: 'Import',
    });
    if (ok) {
      try {
        const r = await call('/dashboard/opportunities/import.csv', {
          method: 'POST',
          headers: { 'content-type': 'text/csv; charset=utf-8' },
          body: await file.text(),
        });
        toast(`Imported ${r.data.imported} updates. They are private drafts awaiting review.`);
        await loadList();
      } catch (error) {
        toast(error.message, 'error');
      }
    }
    importFile.value = '';
  });

  /* ---------- editor ---------- */
  const val = (name) => form.elements.namedItem(name)?.value ?? '';
  const setVal = (name, value) => {
    const el = form.elements.namedItem(name);
    if (!el) return;
    if (el.type === 'checkbox') el.checked = Boolean(value);
    else el.value = value ?? '';
  };
  const parseLabels = (value) => {
    try {
      const parsed = typeof value === 'string' ? JSON.parse(value || '[]') : value;
      return Array.isArray(parsed) ? parsed.filter((x) => typeof x === 'string') : [];
    } catch {
      return [];
    }
  };

  async function loadBrokers() {
    if (brokersLoaded) return;
    try {
      const r = await call('/dashboard/brokers');
      const select = form.elements.namedItem('assignedBrokerId');
      for (const broker of r.data) {
        const option = document.createElement('option');
        option.value = broker.id;
        option.textContent = broker.displayName || broker.email;
        select.add(option);
      }
      brokersLoaded = true;
    } catch {
      /* broker list is optional */
    }
  }

  function renderPublishCard(o) {
    const stage = stageOf(o);
    const card = $('op-publish-card');
    card.hidden = false;
    const reached = stage === 'live' ? 3 : stage === 'ready' ? 2 : 1;
    card
      .querySelectorAll('#op-steps li')
      .forEach((li, index) => li.classList.toggle('is-done', index < reached));
    const closed = stage === 'closed';
    const help = {
      draft: isPublisher
        ? 'Check the details, then approve the listing. Approving records today as the verification date.'
        : 'When the details are ready, send it for review. A publisher will approve it.',
      review: isPublisher
        ? 'Waiting for a publisher. Approve it when the details are checked.'
        : 'Waiting for a publisher to approve it.',
      ready: isPublisher
        ? 'Approved. Publish it to show it on the website.'
        : 'Approved. A publisher can publish it.',
      live: 'This listing is visible on the website.',
      closed: `This listing is ${String(o.lifecycle).replace('_', ' ')}, so it is hidden from the website.`,
    }[stage];
    $('op-publish-help').textContent = help;
    const box = $('op-publish-actions');
    const buttons = [];
    if (!isPublisher) {
      if (stage === 'draft')
        buttons.push(
          '<button type="button" class="dx-btn dx-btn-primary" data-wf="submit">Send for review</button>',
        );
    } else if (closed) {
      buttons.push(
        '<button type="button" class="dx-btn" data-wf="restore">Restore listing</button>',
      );
    } else {
      if (stage === 'draft' || stage === 'review')
        buttons.push(
          '<button type="button" class="dx-btn dx-btn-primary" data-wf="approve">Approve</button>',
        );
      if (stage === 'draft')
        buttons.push(
          '<button type="button" class="dx-btn" data-wf="submit">Mark as in review</button>',
        );
      if (stage === 'ready') {
        buttons.push(
          '<button type="button" class="dx-btn dx-btn-primary" data-wf="publish">Publish</button>',
        );
        buttons.push(
          '<button type="button" class="dx-btn" data-wf="unapprove">Remove approval</button>',
        );
      }
      if (stage === 'live')
        buttons.push('<button type="button" class="dx-btn" data-wf="unpublish">Unpublish</button>');
      buttons.push(
        '<button type="button" class="dx-btn" data-wf="reverify">Re-verify details</button>',
      );
      buttons.push(
        '<button type="button" class="dx-btn dx-btn-ghost-danger" data-wf="archive">Archive</button>',
      );
    }
    box.innerHTML = buttons.join('');
    $('op-stage-badge').innerHTML = stageBadge({ ...o, stage, lifecycle: o.lifecycle });
    $('op-live-warning').hidden = stage !== 'live';
    $('op-save-publish').hidden = !isPublisher || !current;
    const link = $('op-view-live');
    link.hidden = stage !== 'live';
    if (!link.hidden) link.href = `/opportunities/${encodeURIComponent(o.slug)}`;
  }

  $('op-publish-actions').addEventListener('click', async (event) => {
    const b = event.target.closest('[data-wf]');
    if (!b || !current) return;
    const action = b.dataset.wf;
    if (action === 'reverify') {
      const dlg = modal(
        'Re-verify this listing',
        '<form class="dx-form" id="verify-form"><label class="dx-field">What did you check?<textarea name="reason" minlength="3" maxlength="500" required></textarea></label><div class="dx-actions"><button type="button" class="dx-btn" data-close>Cancel</button><button type="submit" class="dx-btn dx-btn-primary">Mark verified today</button></div></form>',
      );
      dlg.el.querySelector('#verify-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        try {
          await call(
            `/dashboard/opportunities/${encodeURIComponent(current.id)}/verify`,
            json('POST', { reason: new FormData(e.currentTarget).get('reason') }),
          );
          dlg.close();
          toast('Verification date updated.');
        } catch (error) {
          toast(error.message, 'error');
        }
      });
      return;
    }
    if (['unpublish', 'unapprove', 'archive'].includes(action)) {
      const ok = await confirmBox({
        title:
          action === 'archive'
            ? 'Archive this listing?'
            : action === 'unpublish'
              ? 'Unpublish this listing?'
              : 'Remove approval?',
        message: 'It will be hidden from the website until it is approved and published again.',
        confirmLabel:
          action === 'archive'
            ? 'Archive'
            : action === 'unpublish'
              ? 'Unpublish'
              : 'Remove approval',
        danger: true,
      });
      if (!ok) return;
    }
    await runAndRefresh(current.id, action);
  });

  function showList() {
    editorView.hidden = true;
    listView.hidden = false;
    current = null;
    loadList();
    window.scrollTo({ top: 0 });
  }

  async function openEditor(id, keepScroll = false) {
    await loadBrokers();
    form.reset();
    $('op-publish-card').hidden = true;
    $('op-media-card').hidden = true;
    $('op-history-card').hidden = true;
    $('op-live-warning').hidden = true;
    $('op-stage-badge').innerHTML = '';
    $('op-view-live').hidden = true;
    $('op-save-publish').hidden = true;
    if (id) {
      try {
        const r = await call(`/dashboard/opportunities/${encodeURIComponent(id)}`);
        current = r.data;
      } catch (error) {
        toast(error.message, 'error');
        return showList();
      }
      const map = {
        title: 'title',
        country: 'country',
        opportunity_type: 'opportunityType',
        price_text: 'priceText',
        price_visibility: 'priceVisibility',
        summary: 'summary',
        availability: 'availability',
        seo_title: 'seoTitle',
        seo_description: 'seoDescription',
        body_html: 'bodyHtml',
        assigned_broker_id: 'assignedBrokerId',
        classification: 'classification',
      };
      for (const [key, name] of Object.entries(map)) setVal(name, current[key]);
      setVal('labels', parseLabels(current.labels_json).join(', '));
      setVal('id', current.id);
      $('op-heading').textContent = current.title;
      renderPublishCard(current);
      $('op-media-card').hidden = false;
      $('op-history-card').hidden = false;
      loadMedia();
      loadHistory();
    } else {
      current = null;
      setVal('id', '');
      $('op-heading').textContent = 'New opportunity';
    }
    listView.hidden = true;
    editorView.hidden = false;
    if (!keepScroll) window.scrollTo({ top: 0 });
    if (!id) form.elements.namedItem('title').focus();
  }

  function payload() {
    const data = Object.fromEntries(
      [
        'title',
        'country',
        'opportunityType',
        'classification',
        'priceText',
        'summary',
        'availability',
        'seoTitle',
        'seoDescription',
        'bodyHtml',
      ].map((name) => [name, val(name)]),
    );
    data.assignedBrokerId = val('assignedBrokerId') || null;
    data.labels = val('labels')
      .split(',')
      .map((label) => label.trim())
      .filter(Boolean)
      .slice(0, 12);
    if (isPublisher)
      data.priceVisibility = Boolean(form.elements.namedItem('priceVisibility')?.checked);
    return data;
  }

  async function save() {
    const data = payload();
    if (current) {
      await call(`/dashboard/opportunities/${encodeURIComponent(current.id)}`, json('PATCH', data));
      return current.id;
    }
    const created = await call('/dashboard/opportunities', json('POST', data));
    return created.data.id;
  }

  function goto(hash) {
    if (location.hash !== hash) location.hash = hash;
    else route();
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    try {
      const id = await save();
      toast('Saved as a draft. It needs approval before it can go live.');
      history.replaceState(null, '', `#edit/${id}`);
      await openEditor(id, true);
    } catch (error) {
      toast(error.message, 'error');
    }
  });

  $('op-save-publish').addEventListener('click', async () => {
    try {
      const id = await save();
      const approved = await act(id, 'approve');
      if (!approved) return openEditor(id, true);
      const live = await act(id, 'publish');
      toast(
        live ? 'Saved and live on the website.' : 'Saved and approved. Publishing needs attention.',
      );
      await openEditor(id, true);
    } catch (error) {
      toast(error.message, 'error');
    }
  });

  /* ---------- images ---------- */
  async function loadMedia() {
    const list = $('op-media-list');
    list.innerHTML = '<li class="dx-secondary">Loading…</li>';
    try {
      const r = await call(`/dashboard/opportunities/${encodeURIComponent(current.id)}/media`);
      list.innerHTML = r.data.length
        ? r.data
            .map(
              (item, index) =>
                `<li><span>${esc(item.altText)}${index === 0 ? ' <small>(cover)</small>' : ''}<small class="dx-secondary"> ${Math.ceil(item.byteSize / 1024)} KB</small></span><button type="button" class="dx-btn dx-btn-sm dx-btn-ghost-danger" data-media="${esc(item.id)}">Remove</button></li>`,
            )
            .join('')
        : '<li class="dx-secondary">No images yet.</li>';
    } catch (error) {
      list.innerHTML = `<li class="dx-secondary">${esc(error.message)}</li>`;
    }
  }
  $('op-media-list').addEventListener('click', async (event) => {
    const b = event.target.closest('[data-media]');
    if (!b || !current) return;
    try {
      await call(
        `/dashboard/opportunities/${encodeURIComponent(current.id)}/media/${encodeURIComponent(b.dataset.media)}`,
        { method: 'DELETE' },
      );
      toast('Image removed.');
      loadMedia();
    } catch (error) {
      toast(error.message, 'error');
    }
  });
  $('op-media-upload').addEventListener('click', async () => {
    const file = $('op-media-file').files?.[0];
    const alt = $('op-media-alt').value.trim();
    if (!current) return toast('Save the listing before uploading images.', 'error');
    if (!file || !alt) return toast('Choose an image and describe it.', 'error');
    const data = new FormData();
    data.append('file', file);
    data.append('altText', alt);
    try {
      await call(`/dashboard/opportunities/${encodeURIComponent(current.id)}/media`, {
        method: 'POST',
        body: data,
      });
      $('op-media-file').value = '';
      $('op-media-alt').value = '';
      toast('Image uploaded.');
      loadMedia();
    } catch (error) {
      toast(error.message, 'error');
    }
  });

  /* ---------- version history ---------- */
  async function loadHistory() {
    const list = $('op-history-list');
    list.innerHTML = '<li class="dx-secondary">Loading…</li>';
    try {
      const r = await call(`/dashboard/opportunities/${encodeURIComponent(current.id)}/versions`);
      list.innerHTML = r.data.length
        ? r.data
            .map(
              (v) =>
                `<li><span>Version ${esc(v.versionNumber)}<small class="dx-secondary"> ${window.DX.fmtDate(v.createdAt)} · ${esc(v.changeReason || 'No reason recorded')}</small></span><button type="button" class="dx-btn dx-btn-sm" data-restore="${esc(v.versionNumber)}">Restore as draft</button></li>`,
            )
            .join('')
        : '<li class="dx-secondary">No saved versions yet.</li>';
    } catch (error) {
      list.innerHTML = `<li class="dx-secondary">${esc(error.message)}</li>`;
    }
  }
  $('op-history-list').addEventListener('click', (event) => {
    const b = event.target.closest('[data-restore]');
    if (!b || !current) return;
    const dlg = modal(
      `Restore version ${b.dataset.restore}`,
      '<form class="dx-form" id="restore-form"><div class="dx-note dx-note-warn">The listing returns to a private draft and needs fresh approval.</div><label class="dx-field">Reason<textarea name="reason" minlength="3" maxlength="500" required></textarea></label><div class="dx-actions"><button type="button" class="dx-btn" data-close>Cancel</button><button type="submit" class="dx-btn dx-btn-primary">Restore</button></div></form>',
    );
    dlg.el.querySelector('#restore-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        await call(
          `/dashboard/opportunities/${encodeURIComponent(current.id)}/versions/${encodeURIComponent(b.dataset.restore)}/restore`,
          json('POST', { reason: new FormData(e.currentTarget).get('reason') }),
        );
        dlg.close();
        toast('Version restored as a draft.');
        await openEditor(current.id, true);
      } catch (error) {
        toast(error.message, 'error');
      }
    });
  });

  /* ---------- routing: #new, #edit/<id>, list ---------- */
  function route() {
    const hash = location.hash;
    const edit = hash.match(/^#edit\/(.+)$/);
    if (edit) openEditor(decodeURIComponent(edit[1]));
    else if (hash === '#new') openEditor(null);
    else if (!editorView.hidden) showList();
  }
  window.addEventListener('hashchange', route);
  void goto;

  loadList().then(route);
})();
