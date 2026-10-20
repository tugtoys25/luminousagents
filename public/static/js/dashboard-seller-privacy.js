(() => {
  const cand = document.querySelector('#sp-candidates');
  if (!cand) return;
  const reqs = document.querySelector('#sp-requests');
  const notice = document.querySelector('#sp-notice');
  const dialog = document.querySelector('#sp-confirm');
  const text = document.querySelector('#sp-confirm-text');
  const wrap = document.querySelector('#sp-input-wrap');
  const lab = document.querySelector('#sp-input-label');
  const inp = document.querySelector('#sp-input');
  const when = (iso) => (iso ? new Date(iso).toLocaleString() : '—');
  const label = (s) => String(s ?? '').toLowerCase().replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
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
  /** Resolves to the typed value, or null if cancelled or empty. */
  const ask = (message, inputLabel) => new Promise((resolve) => {
    text.textContent = message; lab.textContent = inputLabel; inp.value = ''; wrap.hidden = false;
    dialog.addEventListener('close', () => resolve(dialog.returnValue === 'ok' && inp.value.trim() ? inp.value.trim() : null), { once: true });
    dialog.showModal();
  });
  async function load() {
    try {
      const c = await api('/dashboard/seller-retention/candidates');
      cand.replaceChildren(h('h2', { text: 'Enquiries due for retention review' }),
        !c.policyConfigured ? h('p', { class: 'muted', text: c.note }) : c.data.length ? h('ul', {}, ...c.data.map((r) => h('li', {}, `${r.reference} · ${label(r.status)} · closed ${when(r.closedAt)} · ${label(r.assetType)} · ${r.assetCountry} `,
          h('button', { type: 'button', text: 'Anonymise…', onclick: async () => {
            const typed = await ask(`Anonymise ${r.reference}? This permanently removes personal data and cannot be undone. Type the reference to confirm.`, 'Reference');
            if (!typed) return;
            const reason = await ask('Reason for anonymisation (recorded in the audit log).', 'Reason'); if (!reason) return;
            try { await api(`/dashboard/seller-enquiries/${r.reference}/anonymise`, 'POST', { reason, confirmReference: typed, confirm: true }); say('Anonymised.'); load(); } catch (e) { say(e.message, true); }
          } }),
          h('button', { type: 'button', text: 'Place legal hold…', onclick: async () => { const reason = await ask('Reason for the legal hold.', 'Reason'); if (!reason) return; try { await api(`/dashboard/seller-enquiries/${r.reference}/legal-hold`, 'POST', { hold: true, reason, confirm: true }); say('Hold placed.'); load(); } catch (e) { say(e.message, true); } } })))) : h('p', { class: 'muted', text: 'Nothing is due for review.' }));
      const q = (await api('/dashboard/seller-privacy-requests')).data;
      reqs.replaceChildren(h('h2', { text: 'Privacy requests' }),
        q.length ? h('ul', {}, ...q.map((r) => h('li', {}, `${r.reference} · ${label(r.requestType)} · ${r.status} · received ${when(r.receivedAt)}${r.dueAt ? ` · due ${when(r.dueAt)}` : ''}${r.enquiryReference ? ` · ${r.enquiryReference}` : ''}${r.outcomeNote ? ` · ${r.outcomeNote}` : ''} `,
          ['OPEN', 'IN_PROGRESS'].includes(r.status) ? h('button', { type: 'button', text: 'Close…', onclick: async () => {
            const note = await ask('Outcome note (5+ characters). Choose COMPLETED by typing COMPLETED or REFUSED in the next prompt.', 'Outcome note'); if (!note) return;
            const status = await ask('Type COMPLETED or REFUSED.', 'Status'); if (!['COMPLETED', 'REFUSED'].includes(status)) { say('Status must be COMPLETED or REFUSED.', true); return; }
            try { await api(`/dashboard/seller-privacy-requests/${r.reference}/update`, 'POST', { status, outcomeNote: note, expectedVersion: r.version, confirm: true }); say('Updated.'); load(); } catch (e) { say(e.message, true); }
          } }) : null))) : h('p', { class: 'muted', text: 'No requests recorded.' }),
        h('button', { type: 'button', class: 'button', text: 'Log a privacy request…', onclick: async () => {
          const type = await ask('Request type: ACCESS, ERASURE, RECTIFICATION, RESTRICTION, MARKETING_WITHDRAWAL or OTHER.', 'Type'); if (!type) return;
          const ref = await ask('Enquiry reference (CM-S-XXXXXX), or leave a single dash if unknown.', 'Reference'); if (!ref) return;
          try { await api('/dashboard/seller-privacy-requests', 'POST', { requestType: type.toUpperCase(), enquiryReference: ref === '-' ? undefined : ref }); say('Request logged.'); load(); } catch (e) { say(e.message, true); }
        } }));
    } catch (e) { cand.replaceChildren(h('p', { class: 'error', role: 'alert', text: e.message })); }
  }
  load();
})();
