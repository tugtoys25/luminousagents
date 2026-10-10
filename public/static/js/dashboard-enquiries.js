(() => {
  const list = document.querySelector('#enq-list');
  if (!list) return;
  const detail = document.querySelector('#enq-detail');
  const notice = document.querySelector('#enq-notice');
  const statusFilter = document.querySelector('#enq-status');
  const search = document.querySelector('#enq-q');
  const role = document.querySelector('meta[name="mayfair-staff"]')?.getAttribute('content') || '';
  const canEdit = !['auditor', 'publisher'].includes(role);
  const canAssign = ['admin', 'editor', 'super_admin'].includes(role);
  const STATUS = ['new', 'assigned', 'in_progress', 'waiting', 'closed', 'spam'];
  const label = (s) => String(s).replace(/_/g, ' ');
  let assignees = [];
  let selectedId = new URLSearchParams(location.search).get('selected') || '';
  let timer;

  const h = (tag, props = {}, ...kids) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (k === 'class') n.className = v;
      else if (k === 'text') n.textContent = v;
      else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
      else if (v !== false && v != null) n.setAttribute(k, v === true ? '' : v);
    }
    n.append(...kids.filter((x) => x != null));
    return n;
  };
  const when = (iso) => (iso ? new Date(iso).toLocaleString() : '');
  const badge = (s) => h('span', { class: `ws-badge ws-badge--${s}`, text: label(s) });

  async function api(url, options = {}) {
    const res = await fetch(url, {
      credentials: 'same-origin',
      ...options,
      headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}) },
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error?.message || 'Request failed.');
    return body;
  }
  const say = (msg, bad) => {
    notice.textContent = msg || '';
    notice.dataset.state = bad ? 'error' : 'ok';
  };

  async function loadList() {
    const params = new URLSearchParams();
    if (statusFilter.value) params.set('status', statusFilter.value);
    if (search.value.trim()) params.set('q', search.value.trim());
    try {
      const { data } = await api(`/dashboard/enquiries?${params}`);
      list.replaceChildren();
      if (!data.length) {
        list.append(h('p', { class: 'muted', text: 'No enquiries match this filter.' }));
        return;
      }
      const table = h(
        'table',
        { class: 'enq-table' },
        h(
          'thead',
          {},
          h(
            'tr',
            {},
            ...['From', 'Opportunity', 'Status', 'Received'].map((t) => h('th', { text: t })),
          ),
        ),
      );
      const body = h('tbody');
      for (const row of data) {
        const open = () => select(row.id);
        const tr = h(
          'tr',
          {
            tabindex: '0',
            'data-id': row.id,
            'aria-selected': String(row.id === selectedId),
            onclick: open,
            onkeydown: (e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                open();
              }
            },
          },
          h(
            'td',
            {},
            h('strong', { text: row.name }),
            h('br'),
            h('small', { text: row.company || row.email }),
          ),
          h('td', { text: row.opportunityTitle || '—' }),
          h('td', {}, badge(row.status)),
          h('td', { text: when(row.createdAt) }),
        );
        body.append(tr);
      }
      table.append(body);
      list.append(table);
    } catch (err) {
      list.textContent = err.message;
    }
  }

  async function select(id) {
    selectedId = id;
    list
      .querySelectorAll('tr[data-id]')
      .forEach((r) => r.setAttribute('aria-selected', String(r.dataset.id === id)));
    detail.replaceChildren(h('p', { class: 'muted', text: 'Loading…' }));
    try {
      const { data: e, notes } = await api(`/dashboard/enquiries/${encodeURIComponent(id)}`);
      render(e, notes || []);
    } catch (err) {
      detail.replaceChildren(h('p', { text: err.message }));
    }
  }

  function render(e, notes) {
    const statusSel = h(
      'select',
      { name: 'status', disabled: !canEdit },
      ...STATUS.map((s) => h('option', { value: s, text: label(s), selected: s === e.status })),
    );
    const assignSel = h(
      'select',
      { name: 'assignedTo', disabled: !canAssign },
      h('option', { value: '', text: 'Unassigned' }),
      ...assignees.map((a) =>
        h('option', {
          value: a.id,
          text: `${a.displayName || a.email} (${a.role.replace('_', ' ')})`,
          selected: a.id === e.assigned_to,
        }),
      ),
    );
    const save = h('button', {
      type: 'button',
      text: 'Save changes',
      disabled: !canEdit,
      onclick: async () => {
        const payload = {};
        if (statusSel.value !== e.status) payload.status = statusSel.value;
        if (canAssign && (assignSel.value || null) !== (e.assigned_to || null)) {
          payload.assignedTo = assignSel.value || null;
          if (assignSel.value && e.status === 'new' && !payload.status) payload.status = 'assigned';
        }
        if (!Object.keys(payload).length) return say('Nothing to save.');
        save.disabled = true;
        try {
          await api(`/dashboard/enquiries/${encodeURIComponent(e.id)}`, {
            method: 'PATCH',
            body: JSON.stringify(payload),
          });
          say('Enquiry updated.');
          await Promise.all([loadList(), select(e.id)]);
        } catch (err) {
          say(err.message, true);
          save.disabled = false;
        }
      },
    });
    const noteBox = h('textarea', {
      name: 'note',
      rows: '3',
      maxlength: '3000',
      placeholder: 'Add an internal note (not sent to the sender)',
      disabled: !canEdit,
    });
    const addNote = h('button', {
      type: 'button',
      class: 'secondary',
      text: 'Add note',
      disabled: !canEdit,
      onclick: async () => {
        const note = noteBox.value.trim();
        if (note.length < 2) return say('Write at least two characters.', true);
        addNote.disabled = true;
        try {
          await api(`/dashboard/enquiries/${encodeURIComponent(e.id)}/notes`, {
            method: 'POST',
            body: JSON.stringify({ note }),
          });
          say('Note added.');
          await select(e.id);
        } catch (err) {
          say(err.message, true);
          addNote.disabled = false;
        }
      },
    });
    const subject = encodeURIComponent('Re: your Casinos of Mayfair enquiry');
    detail.replaceChildren(
      h('h2', { text: e.name }),
      h(
        'p',
        {},
        h('a', { href: `mailto:${e.email}?subject=${subject}`, text: e.email }),
        e.company ? ` · ${e.company}` : '',
      ),
      h('p', { class: 'muted', text: `Received ${when(e.created_at)} · Reference ${e.id}` }),
      h('blockquote', { class: 'enq-message', text: e.message }),
      h(
        'div',
        { class: 'enq-actions' },
        h('label', {}, 'Status', statusSel),
        canAssign ? h('label', {}, 'Assigned to', assignSel) : null,
        save,
      ),
      h('h3', { text: 'Internal notes' }),
      noteBox,
      addNote,
      notes.length
        ? h(
            'ul',
            { class: 'enq-notes' },
            ...notes.map((n) =>
              h(
                'li',
                {},
                h('p', { text: n.note }),
                h('small', { text: `${n.authorEmail} · ${when(n.createdAt)}` }),
              ),
            ),
          )
        : h('p', { class: 'muted', text: 'No notes yet.' }),
    );
  }

  statusFilter.addEventListener('change', loadList);
  search.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(loadList, 250);
  });

  (async () => {
    if (canAssign) {
      try {
        assignees = (await api('/dashboard/assignees')).data || [];
      } catch {
        /* assignment unavailable */
      }
    }
    await loadList();
    if (selectedId) select(selectedId);
  })();
})();
