(() => {
  const listEl = document.querySelector('#sl-list');
  if (!listEl) return;
  const detailEl = document.querySelector('#sl-detail');
  const notice = document.querySelector('#sl-notice');
  const filters = document.querySelector('#sl-filters');
  const dialog = document.querySelector('#sl-confirm');
  const dlgText = document.querySelector('#sl-confirm-text');
  const noteWrap = document.querySelector('#sl-note-wrap');
  const noteEl = document.querySelector('#sl-confirm-note');
  const label = (s) => String(s ?? '').toLowerCase().replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
  const when = (iso) => (iso ? new Date(iso).toLocaleString() : '—');
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
  const say = (msg, bad) => { notice.textContent = msg || ''; notice.dataset.state = bad ? 'error' : 'ok'; };
  async function api(url, method = 'GET', body) {
    const res = await fetch(url, { method, credentials: 'same-origin', headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const unmet = data.error?.unmet?.length ? ` ${data.error.unmet.join(' ')}` : '';
      throw new Error((data.error?.message || 'Request failed.') + unmet);
    }
    return data;
  }
  /** Resolves to the note text (needNote), true, or null when cancelled. */
  function confirmAction(text, needNote) {
    dlgText.textContent = text; noteWrap.hidden = !needNote; noteEl.value = '';
    return new Promise((resolve) => {
      dialog.addEventListener('close', () => {
        if (dialog.returnValue !== 'ok') return resolve(null);
        const note = noteEl.value.trim();
        resolve(needNote ? (note.length >= 3 ? note : null) : true);
      }, { once: true });
      dialog.showModal();
    });
  }
  dlgText.style.whiteSpace = 'pre-wrap';
  dlgText.style.maxHeight = '50vh';
  dlgText.style.overflow = 'auto';
  const dl = (pairs) => h('dl', {}, ...pairs.flatMap(([k, v]) => [h('dt', { text: k }), h('dd', { text: v == null || v === '' ? '—' : String(v) })]));
  const field = (text, el) => h('label', { text: `${text} ` }, el);
  const input = (name, extra = {}) => h('input', { name, ...extra });
  const opts = (name, values) => h('select', { name, required: true }, ...values.map((v) => h('option', { value: v, text: label(v) })));
  const form = (fields, submitText, onSubmit) => {
    const f = h('form', { class: 'se-form' }, ...fields, h('button', { type: 'submit', class: 'button', text: submitText }));
    f.addEventListener('submit', async (e) => { e.preventDefault(); try { await onSubmit(Object.fromEntries(new FormData(f))); } catch (err) { say(err.message, true); } });
    return f;
  };

  let page = 1;
  let selected = new URLSearchParams(location.search).get('selected') || '';
  filters.replaceChildren(
    h('label', { text: 'Status ' }, h('select', { name: 'status' }, h('option', { value: '', text: 'All' }), ...['ACTIVE', 'RESTRICTED', 'INACTIVE'].map((v) => h('option', { value: v, text: label(v) })))),
    h('label', { text: 'Search ' }, input('q', { type: 'search', maxlength: 100, placeholder: 'Reference, name, organisation', autocomplete: 'off' })),
    h('button', { type: 'submit', class: 'button', text: 'Apply' }),
  );
  filters.addEventListener('submit', (e) => { e.preventDefault(); page = 1; loadList(); });

  async function loadList() {
    const params = new URLSearchParams(new FormData(filters));
    for (const [k, v] of [...params]) if (!v) params.delete(k);
    params.set('page', String(page));
    try {
      const b = await api(`/dashboard/sellers?${params}`);
      if (!b.data.length) { listEl.replaceChildren(h('p', { class: 'muted', text: 'No sellers match.' })); return; }
      const pages = Math.max(1, Math.ceil(b.total / b.pageSize));
      listEl.replaceChildren(
        h('table', { class: 'ws-table' }, h('thead', {}, h('tr', {}, ...['Reference', 'Seller', 'Status', 'Owner', 'Enquiries', 'Opportunities'].map((t) => h('th', { scope: 'col', text: t })))),
          h('tbody', {}, ...b.data.map((r) => h('tr', {}, h('td', {}, h('button', { type: 'button', class: 'link-button', text: r.reference, onclick: () => open(r.reference) })),
            h('td', { text: r.displayName }), h('td', { text: label(r.status) }), h('td', { text: r.ownerName || '—' }), h('td', { text: String(r.enquiryCount) }), h('td', { text: String(r.opportunityCount) }))))),
        h('p', {}, h('button', { type: 'button', text: 'Previous', disabled: page <= 1, onclick: () => { page--; loadList(); } }), ` Page ${page} of ${pages} `, h('button', { type: 'button', text: 'Next', disabled: page >= pages, onclick: () => { page++; loadList(); } })));
    } catch (e) { listEl.replaceChildren(h('p', { class: 'error', role: 'alert', text: e.message })); }
  }

  const post = async (url, body, done, ref) => { await api(url, 'POST', body); say(done); await open(ref); };
  async function open(ref) {
    selected = ref; history.replaceState(null, '', `?selected=${encodeURIComponent(ref)}`);
    try { render(await api(`/dashboard/sellers/${encodeURIComponent(ref)}`), ref); } catch (e) { detailEl.replaceChildren(h('p', { class: 'error', role: 'alert', text: e.message })); }
  }
  const list = (title, rows, fmt) => [h('h3', { text: title }), rows.length ? h('ul', {}, ...rows.map((r) => h('li', { text: fmt(r) }))) : h('p', { class: 'muted', text: 'None.' })];

  async function gatePanel(link) {
    const box = h('div', { class: 'se-gate' }, h('p', { class: 'muted', text: 'Loading publication gates…' }));
    try {
      const g = (await api(`/dashboard/opportunities/${encodeURIComponent(link.opportunityId)}/seller-gates`)).data;
      const r = g.review;
      const flags = ['scopeConfirmed', 'confidentialityReviewed', 'publicFieldsApproved', 'sensitiveDataReviewed', 'imageRightsChecked', 'legalReviewCompleted'];
      box.replaceChildren(
        h('p', { text: g.unmet.length ? 'Publication is BLOCKED:' : 'All seller publication gates are satisfied (normal publication approval still applies).' }),
        g.unmet.length ? h('ul', {}, ...g.unmet.map((m) => h('li', { text: m }))) : null,
        h('p', { class: 'muted', text: r ? `Review: ${label(r.status)} (v${r.version})` : 'No publication review prepared.' }),
        r && r.status === 'APPROVED' ? null : form([
          field('Publication scope', input('scopeText', { maxlength: 1000, value: r?.scopeText || '' })),
          ...flags.map((f) => h('label', {}, h('input', { type: 'checkbox', name: f, checked: r?.[f] === 1 }), ` ${label(f.replace(/([A-Z])/g, ' $1'))}`)),
          field('Notes', input('notes', { maxlength: 2000, value: r?.notes || '' })),
        ], 'Save review', async (v) => post(`/dashboard/opportunities/${encodeURIComponent(link.opportunityId)}/seller-publication-review`, { action: 'save', expectedVersion: r?.version, scopeText: v.scopeText, notes: v.notes, ...Object.fromEntries(flags.map((f) => [f, v[f] === 'on'])) }, 'Review saved.', selected)),
        r ? h('div', { class: 'se-actions' }, ...['approve', 'reject', 'revoke'].filter((a) => (a === 'revoke') === (r.status === 'APPROVED') && (a !== 'approve' || r.status === 'DRAFT') && (a !== 'reject' || r.status === 'DRAFT')).map((a) => h('button', { type: 'button', class: 'button', text: label(a), onclick: async () => {
          const note = await confirmAction(`${label(a)} this publication review?`, a !== 'approve');
          if (note) try { await post(`/dashboard/opportunities/${encodeURIComponent(link.opportunityId)}/seller-publication-review`, { action: a, expectedVersion: r.version, confirm: true, reason: typeof note === 'string' ? note : undefined }, `Review ${a}d.`, selected); } catch (e) { say(e.message, true); }
        } }))) : null,
      );
    } catch (e) { box.replaceChildren(h('p', { class: 'error', text: e.message })); }
    return box;
  }

  function render(b, ref) {
    const d = b.data;
    const parts = [h('h2', { text: d.reference }), dl([['Seller', d.displayName], ['Organisation', d.organisation], ['Contact', d.contactName], ['Email', d.contactEmail], ['Telephone', d.contactTelephone], ['Owner', d.ownerName], ['Status', label(d.status)],
      ['Confidentiality restrictions', d.confidentialityRestrictions], ['Created', when(d.createdAt)], ['Last updated', when(d.updatedAt)]])];
    parts.push(h('h3', { text: 'Correct details (recorded with reason)' }), form([field('Contact name', input('contactName', { value: d.contactName, maxlength: 120 })), field('Contact email', input('contactEmail', { type: 'email', value: d.contactEmail, maxlength: 254 })),
      field('Restrictions', input('confidentialityRestrictions', { value: d.confidentialityRestrictions, maxlength: 2000 })), field('Reason', input('reason', { required: true, minlength: 5, maxlength: 500 }))], 'Save correction', async (v) => {
      const changes = {};
      for (const k of ['contactName', 'contactEmail', 'confidentialityRestrictions']) if (v[k] !== (d[k] ?? '')) changes[k] = v[k];
      if (!Object.keys(changes).length) { say('Nothing changed.', true); return; }
      await post(`/dashboard/sellers/${ref}/update`, { expectedVersion: d.version, reason: v.reason, changes }, 'Seller updated.', ref);
    }));
    parts.push(...list('Linked enquiries', b.enquiries, (e) => `${e.reference} · ${label(e.status)} · ${label(e.assetType)} · ${e.assetCountry} · ${when(e.createdAt)}`));
    parts.push(h('h3', { text: 'Linked opportunities' }));
    if (!b.links.length) parts.push(h('p', { class: 'muted', text: 'None.' }));
    const pending = [];
    for (const l of b.links) {
      const recs = b.authority.filter((r) => r.linkId === l.id);
      const block = h('div', { class: 'se-link' }, h('h4', { text: `${l.opportunityTitle} — ${label(l.role)} (${label(l.relationshipStatus)})` }),
        h('p', { class: 'muted', text: `Lifecycle ${label(l.lifecycle)}; ${l.publicVisibility ? 'PUBLIC' : 'not public'}; restrictions review: ${label(l.reviewStatus)}${l.confidentialityRestrictions ? ` — ${l.confidentialityRestrictions}` : ''}` }));
      if (l.relationshipStatus === 'ACTIVE' && b.canReview) {
        block.append(l.reviewStatus === 'REVIEWED' ? null : h('button', { type: 'button', class: 'button', text: 'Mark confidentiality restrictions reviewed', onclick: async () => { if (await confirmAction('Confirm you reviewed this seller’s confidentiality restrictions.', false)) try { await post(`/dashboard/sellers/${ref}/links/${l.id}/review`, { confirm: true }, 'Reviewed.', ref); } catch (e) { say(e.message, true); } } }),
          h('button', { type: 'button', text: 'End relationship', onclick: async () => { if (await confirmAction('End this relationship? The opportunity stays under seller publication gates.', false)) try { await post(`/dashboard/sellers/${ref}/links/${l.id}/end`, { confirm: true }, 'Relationship ended.', ref); } catch (e) { say(e.message, true); } } }));
      }
      for (const r of recs) {
        block.append(h('p', {}, `${r.reference} · ${label(r.authorityType)} · ${label(r.status)} · evidence: ${label(r.evidenceType)}${r.evidenceRef ? ` (${r.evidenceRef})` : ''} · valid ${r.validFrom ? when(r.validFrom) : 'n/a'} → ${r.validUntil ? when(r.validUntil) : 'no expiry'} · scope: ${r.scope || '—'} · recorded by ${r.createdByName || '—'}${r.reviewerName ? `, reviewed by ${r.reviewerName} ${when(r.reviewedAt)}` : ''} `,
          ...(b.canReview ? r.allowedTransitions.map((to) => h('button', { type: 'button', text: `→ ${label(to)}`, onclick: async () => {
            const note = await confirmAction(`Move ${r.reference} to ${label(to)}? Enter a review note.`, true);
            if (!note) return;
            const body = { to, note, expectedVersion: r.version, confirm: true };
            if (to === 'VERIFIED') { const t = window.prompt('Evidence type (POWER_OF_ATTORNEY, BOARD_RESOLUTION, SIGNED_MANDATE, OWNERSHIP_RECORD, OTHER):', r.evidenceType === 'NONE' ? '' : r.evidenceType); const s = window.prompt('Scope of authority:', r.scope || ''); const u = window.prompt('Valid until (ISO date-time, blank for none):', r.validUntil || ''); if (t) body.evidenceType = t; if (s) body.scope = s; if (u) body.validUntil = u; }
            try { await post(`/dashboard/authority/${r.reference}/transition`, body, `Moved to ${label(to)}.`, ref); } catch (e) { say(e.message, true); }
          } })) : [])));
      }
      if (l.relationshipStatus === 'ACTIVE') block.append(form([field('Type', opts('authorityType', ['AUTHORITY_TO_MARKET', 'BROKERAGE_MANDATE', 'AUTHORITY_TO_REPRESENT', 'AUTHORITY_TO_NEGOTIATE', 'AUTHORITY_TO_SUBMIT'])), field('Evidence', opts('evidenceType', ['NONE', 'POWER_OF_ATTORNEY', 'BOARD_RESOLUTION', 'SIGNED_MANDATE', 'OWNERSHIP_RECORD', 'OTHER'])), field('Evidence reference (not a URL)', input('evidenceRef', { maxlength: 120 })), field('Scope', input('scope', { maxlength: 1000 }))],
        'Record authority claim', (v) => post(`/dashboard/sellers/${ref}/links/${l.id}/authority`, { authorityType: v.authorityType, evidenceType: v.evidenceType, evidenceRef: v.evidenceRef || undefined, scope: v.scope || undefined }, 'Recorded as NOT_REVIEWED.', ref)));
      parts.push(block); pending.push(gatePanel(l).then((p) => block.append(h('h4', { text: 'Publication gates' }), p)));
    }
    parts.push(h('h3', { text: 'Material interest' }), h('p', { class: 'muted', text: 'Internal record. Only the reviewed summary is ever sent to the seller; never name the buyer or disclose terms in it. Nothing is sent automatically.' }));
    for (const i of b.interests) {
      const row = h('div', { class: 'se-link' }, h('p', { text: `${i.reference} · ${label(i.interestType)} · ${label(i.stage)} · ${i.opportunityTitle} · received ${when(i.receivedAt)} · source: ${i.source} · internal: ${i.summaryInternal}${i.buyerReference ? ` · buyer ref (internal): ${i.buyerReference}` : ''}${i.approvedSummary ? ` · approved summary: ${i.approvedSummary}` : ''}` }));
      const act = (text, fn) => h('button', { type: 'button', text, onclick: async () => { try { await fn(); } catch (e) { say(e.message, true); } } });
      const review = (action, extra = {}) => async () => { const note = await confirmAction(`${label(action)} ${i.reference}? Enter a note.`, true); if (note) await post(`/dashboard/material-interests/${i.reference}/review`, { action, expectedVersion: i.version, note, confirm: true, ...extra }, 'Updated.', ref); };
      if (i.stage === 'RECORDED') row.append(act('Start review', review('start_review')));
      if (i.stage === 'UNDER_REVIEW' && b.canReview) row.append(act('Approve for seller notification…', async () => {
        const approvedSummary = window.prompt('Approved summary for the seller (no buyer identity, no terms):', ''); const proposedNextStep = approvedSummary && window.prompt('Proposed next step:', ''); const stageLabel = proposedNextStep && window.prompt('Current stage (wording shown to the seller):', '');
        if (stageLabel && confirm('I confirm the confidentiality review is complete and this seller is entitled to be told.')) await review('approve', { approvedSummary, proposedNextStep, stageLabel, confidentialityChecked: true, notificationEligible: true })();
      }), act('Reject', review('reject')));
      if (['RECORDED', 'UNDER_REVIEW', 'APPROVED'].includes(i.stage) && b.canReview) row.append(act('Withdraw', review('withdraw')));
      if (i.stage === 'APPROVED') row.append(act('Draft seller notice…', async () => {
        const brokerTitle = window.prompt('Your title for the signature:', ''); if (!brokerTitle) return;
        const draft = (await api(`/dashboard/material-interests/${i.reference}/notification-draft`, 'POST', { brokerTitle })).data;
        if (!b.canReview) { say('Draft created. An approver must review and send it.'); return; }
        if (await confirmAction(`CONFIDENTIAL — to the seller only\nTo: ${draft.recipient}\nSubject: ${draft.subject}\n\n${draft.text}\n\nApprove and send exactly this email?`, false)) { await api(`/dashboard/seller-material-notices/${draft.id}/send`, 'POST', { expectedVersion: draft.version, confirm: true }); say('Queued. It re-checks eligibility just before sending.'); await open(ref); }
      }));
      parts.push(row);
    }
    for (const l of b.links.filter((x) => x.relationshipStatus === 'ACTIVE')) {
      parts.push(form([field(`Record interest on “${l.opportunityTitle}”`, opts('interestType', ['INITIAL_ENQUIRY', 'REQUEST_FOR_INFORMATION', 'MEETING_REQUEST', 'INDICATION_OF_INTEREST', 'INDICATIVE_PROPOSAL', 'FORMAL_OFFER'])), field('Source', input('source', { required: true, maxlength: 200 })), field('Internal summary', input('summary', { required: true, maxlength: 2000 })), field('Buyer reference (internal)', input('buyerReference', { maxlength: 120 }))],
        'Record interest', (v) => post(`/dashboard/sellers/${ref}/links/${l.id}/interests`, { interestType: v.interestType, source: v.source, summary: v.summary, buyerReference: v.buyerReference || undefined }, 'Interest recorded.', ref)));
    }
    parts.push(...list('Open and completed follow-ups', b.followups, (t) => `${t.status} · ${t.title} · due ${when(t.dueAt)}${t.outcome ? ` · ${t.outcome}` : ''}`),
      ...list('Communications', b.communications, (c) => `${when(c.occurredAt)} · ${c.direction} ${label(c.channel)} · ${label(c.outcome)} — ${c.summary}`),
      ...list('Staff notes', b.notes, (n) => `${when(n.createdAt)} · ${n.authorName} · ${label(n.classification)} — ${n.note}`),
      ...list('Corrections', b.changes, (c) => `${when(c.createdAt)} · ${c.actorName} · ${c.field}: ${c.oldValue ?? '—'} → ${c.newValue ?? '—'} (${c.reason})`),
      ...list('Audit trail', b.audit, (a) => `${when(a.createdAt)} · ${a.actorName || a.actorType} · ${a.action}`));
    detailEl.replaceChildren(...parts);
  }
  loadList().then(() => { if (selected) open(selected); });
})();
