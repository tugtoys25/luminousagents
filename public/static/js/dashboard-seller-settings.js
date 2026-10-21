(() => {
  const listEl = document.querySelector('#ss-list');
  if (!listEl) return;
  const notice = document.querySelector('#ss-notice');
  const dialog = document.querySelector('#ss-confirm');
  const text = document.querySelector('#ss-confirm-text');
  const reasonEl = document.querySelector('#ss-reason');
  const when = (iso) => (iso ? new Date(iso).toLocaleString() : '—');
  const h = (tag, props = {}, ...kids) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) { if (k === 'text') n.textContent = v; else if (k.startsWith('on')) n.addEventListener(k.slice(2), v); else if (v !== false && v != null) n.setAttribute(k, v === true ? '' : v); }
    n.append(...kids.filter((x) => x != null)); return n;
  };
  const say = (m, bad) => { notice.textContent = m || ''; notice.dataset.state = bad ? 'error' : 'ok'; };
  async function api(url, method = 'GET', body) {
    const res = await fetch(url, { method, credentials: 'same-origin', headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error?.message || 'Request failed.');
    return data;
  }
  const askReason = (message) => new Promise((resolve) => {
    text.textContent = message; reasonEl.value = '';
    dialog.addEventListener('close', () => { const r = reasonEl.value.trim(); resolve(dialog.returnValue === 'ok' && r.length >= 5 ? r : null); }, { once: true });
    dialog.showModal();
  });
  const show = (s) => (s.kind === 'emails' ? (s.value.length ? s.value.join(', ') : '(none)') : s.value === null ? '(not set)' : String(s.value));
  function editor(s) {
    if (s.kind === 'boolean') return h('select', { name: 'v' }, h('option', { value: 'true', text: 'On', selected: s.value === true }), h('option', { value: 'false', text: 'Off', selected: s.value === false }));
    if (s.kind === 'emails') return h('input', { name: 'v', value: s.value.join(', '), maxlength: 2600, placeholder: 'a@example.com, b@example.com' });
    return h('input', { name: 'v', type: 'number', value: s.value === null ? '' : String(s.value), min: s.min ?? 0, max: s.max ?? 1000000 });
  }
  const parse = (s, raw) => {
    if (s.kind === 'boolean') return raw === 'true';
    if (s.kind === 'emails') return raw.split(',').map((x) => x.trim()).filter(Boolean);
    return raw === '' ? null : Number(raw);
  };
  async function load() {
    try {
      const rows = (await api('/dashboard/seller-settings')).data;
      listEl.replaceChildren(...rows.map((s) => {
        const f = h('form', { class: 'se-form' }, h('label', { text: 'New value ' }, editor(s)), h('button', { type: 'submit', class: 'button', text: 'Save', disabled: !s.editable }));
        f.addEventListener('submit', async (e) => {
          e.preventDefault();
          const v = parse(s, new FormData(f).get('v'));
          const reason = await askReason(`Change “${s.label}” to ${JSON.stringify(v)}? Enter the reason.`); if (!reason) return;
          try { await api(`/dashboard/seller-settings/${s.key}`, 'POST', { value: v, expectedVersion: s.version, reason, confirm: true }); say('Saved.'); load(); } catch (err) { say(err.message, true); }
        });
        return h('section', { class: 'se-link' }, h('h3', { text: s.label + (s.sensitive ? ' (sensitive)' : '') }), h('p', { class: 'muted', text: s.description }),
          h('p', { text: `Current: ${show(s)} · source: ${s.source}${s.updatedAt ? ` · changed ${when(s.updatedAt)} by ${s.updatedBy || '—'}` : ''}${s.editable ? '' : ' · super admin only'}` }), f,
          s.source === 'database' && s.editable ? h('button', { type: 'button', text: 'Reset to environment/default', onclick: async () => {
            const reason = await askReason(`Reset “${s.label}” to the environment value or default? Enter the reason.`); if (!reason) return;
            try { await api(`/dashboard/seller-settings/${s.key}`, 'POST', { reset: true, expectedVersion: s.version, reason, confirm: true }); say('Reset.'); load(); } catch (err) { say(err.message, true); }
          } }) : null);
      }));
    } catch (e) { listEl.replaceChildren(h('p', { class: 'error', role: 'alert', text: e.message })); }
  }
  load();
})();
