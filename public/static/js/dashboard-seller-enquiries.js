(() => {
  const listEl = document.querySelector('#se-list');
  if (!listEl) return;
  const detailEl = document.querySelector('#se-detail');
  const notice = document.querySelector('#se-notice');
  const filters = document.querySelector('#se-filters');
  const dialog = document.querySelector('#se-confirm');
  const dlgText = document.querySelector('#se-confirm-text');
  const reasonWrap = document.querySelector('#se-reason-wrap');
  const reasonEl = document.querySelector('#se-confirm-reason');
  dlgText.style.whiteSpace = 'pre-wrap';
  dlgText.style.maxHeight = '50vh';
  dlgText.style.overflow = 'auto';
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
    if (!res.ok) throw new Error(data.error?.message || 'Request failed.');
    return data;
  }
  /** Returns the reason text, true, or null when cancelled. */
  function confirmAction(text, needReason) {
    dlgText.textContent = text;
    reasonWrap.hidden = !needReason;
    reasonEl.value = '';
    return new Promise((resolve) => {
      dialog.addEventListener('close', () => {
        if (dialog.returnValue !== 'ok') return resolve(null);
        const reason = reasonEl.value.trim();
        resolve(needReason ? (reason.length >= 5 ? reason : null) : true);
      }, { once: true });
      dialog.showModal();
    });
  }

  let page = 1;
  let selected = new URLSearchParams(location.search).get('selected') || '';
  let assignees = [];
  const STATUSES = ['NEW', 'ASSIGNED', 'CONTACT_ATTEMPTED', 'AWAITING_SELLER', 'QUALIFICATION', 'AUTHORITY_REVIEW', 'QUALIFIED', 'CONVERTED', 'DECLINED', 'CLOSED'];
  const ASSETS = ['CASINO', 'CASINO_HOTEL', 'HOTEL_RESORT_WITH_CASINO', 'OPERATING_COMPANY', 'RELATED_PROPERTY_HOSPITALITY_ASSET', 'OTHER_RELATED_INVESTMENT'];
  const select = (name, text, options) => h('label', { text: `${text} ` }, h('select', { name }, h('option', { value: '', text: 'All' }), ...options.map(([v, t]) => h('option', { value: v, text: t }))));

  function buildFilters() {
    filters.replaceChildren(
      select('status', 'Status', STATUSES.map((s) => [s, label(s)])),
      select('assigned', 'Broker', [['unassigned', 'Unassigned'], ...assignees.map((a) => [a.id, a.displayName || a.email])]),
      select('assetType', 'Asset type', ASSETS.map((a) => [a, label(a)])),
      select('due', 'Follow-up', [['overdue', 'Overdue'], ['today', 'Due today or earlier']]),
      h('label', { text: 'Country (ISO code) ' }, h('input', { name: 'country', maxlength: 2, pattern: '[A-Za-z]{2}', size: 3, autocomplete: 'off' })),
      h('label', { text: 'From ' }, h('input', { name: 'from', type: 'date' })),
      h('label', { text: 'To ' }, h('input', { name: 'to', type: 'date' })),
      h('label', { text: 'Search ' }, h('input', { name: 'q', type: 'search', maxlength: 100, placeholder: 'Reference, name, organisation', autocomplete: 'off' })),
      h('button', { type: 'submit', class: 'button', text: 'Apply' }),
    );
  }
  filters.addEventListener('submit', (e) => { e.preventDefault(); page = 1; loadList(); });

  async function loadList() {
    const params = new URLSearchParams(new FormData(filters));
    for (const [k, v] of [...params]) if (!v) params.delete(k);
    if (params.get('country')) params.set('country', params.get('country').toUpperCase());
    params.set('page', String(page));
    listEl.setAttribute('aria-busy', 'true');
    try {
      const body = await api(`/dashboard/seller-enquiries?${params}`);
      if (!body.data.length) { listEl.replaceChildren(h('p', { class: 'muted', text: 'No seller enquiries match these filters.' })); return; }
      const rows = body.data.map((r) => h('tr', {},
        h('td', {}, h('button', { type: 'button', class: 'link-button', text: r.reference, onclick: () => open(r.reference) })),
        h('td', { text: r.contactName + (r.organisation ? ` · ${r.organisation}` : '') }),
        h('td', { text: label(r.status) }),
        h('td', { text: `${label(r.assetType)} · ${r.assetCountry}${r.assetNameConfidential ? ' · 🔒' : ''}` }),
        h('td', { text: r.assignedName || 'Unassigned' }),
        h('td', { text: r.nextFollowupAt ? when(r.nextFollowupAt) + (new Date(r.nextFollowupAt) < new Date() ? ' (overdue)' : '') : '—' }),
        h('td', { text: when(r.createdAt) })));
      const pages = Math.max(1, Math.ceil(body.total / body.pageSize));
      listEl.replaceChildren(
        h('table', { class: 'ws-table' }, h('thead', {}, h('tr', {}, ...['Reference', 'Seller', 'Status', 'Asset', 'Owner', 'Next follow-up', 'Received'].map((t) => h('th', { scope: 'col', text: t })))), h('tbody', {}, ...rows)),
        h('p', {}, h('button', { type: 'button', text: 'Previous', disabled: page <= 1, onclick: () => { page--; loadList(); } }), ` Page ${page} of ${pages} (${body.total}) `, h('button', { type: 'button', text: 'Next', disabled: page >= pages, onclick: () => { page++; loadList(); } })));
    } catch (e) { listEl.replaceChildren(h('p', { class: 'error', role: 'alert', text: e.message })); } finally { listEl.removeAttribute('aria-busy'); }
  }

  const dl = (pairs) => h('dl', {}, ...pairs.flatMap(([k, v]) => [h('dt', { text: k }), h('dd', { text: v == null || v === '' ? '—' : String(v) })]));
  const form = (fields, submitText, onSubmit) => {
    const f = h('form', { class: 'se-form' }, ...fields, h('button', { type: 'submit', class: 'button', text: submitText }));
    f.addEventListener('submit', async (e) => { e.preventDefault(); try { await onSubmit(Object.fromEntries(new FormData(f))); } catch (err) { say(err.message, true); } });
    return f;
  };
  const field = (name, text, el) => h('label', { text: `${text} ` }, el || h('input', { name, required: true }));
  const opts = (name, values) => h('select', { name, required: true }, ...values.map((v) => h('option', { value: v, text: label(v) })));

  async function open(ref) {
    selected = ref;
    history.replaceState(null, '', `?selected=${encodeURIComponent(ref)}`);
    detailEl.setAttribute('aria-busy', 'true');
    try {
      const b = await api(`/dashboard/seller-enquiries/${encodeURIComponent(ref)}`);
      render(b);
    } catch (e) { detailEl.replaceChildren(h('p', { class: 'error', role: 'alert', text: e.message })); } finally { detailEl.removeAttribute('aria-busy'); }
  }
  const post = async (ref, path, body, done) => { await api(`/dashboard/seller-enquiries/${encodeURIComponent(ref)}/${path}`, 'POST', body); say(done); await open(ref); loadList(); };

  function render(b) {
    const d = b.data;
    const parts = [h('h2', { text: d.reference }), h('p', { class: 'muted', text: 'Unqualified lead. Declarations are the submitter’s own and are not verified authority.' })];
    parts.push(dl([
      ['Status', label(d.status)], ['Owner', d.assignedName || 'Unassigned'], ['Contact', `${d.contactName} (${label(d.contactRole)}${d.contactRoleOther ? `: ${d.contactRoleOther}` : ''})`],
      ['Email', d.email], ['Telephone', d.telephone], ['Organisation', d.organisation], ['Preferred contact', label(d.preferredContactMethod)], ['Contact country', d.contactCountry],
      ['Asset', `${label(d.assetType)}${d.assetTypeOther ? `: ${d.assetTypeOther}` : ''} · ${d.assetCountry}`], ['Asset name', d.assetName ? `${d.assetName}${d.assetNameConfidential ? ' (CONFIDENTIAL)' : ''}` : d.assetNameConfidential ? 'Confidential' : ''],
      ['Operating status', label(d.operatingStatus)], ['Sale timing', label(d.saleTiming)], ['Reason for sale', d.saleReason && label(d.saleReason)],
      ['Asking price (as stated)', d.askingPriceText ? `${d.askingPriceText} ${d.currency === 'OTHER' ? d.currencyOther : d.currency || ''}` : ''],
      ['Confidentiality preference', label(d.confidentialityPreference)], ['Authority declaration (unverified)', d.authorityDeclaration],
      ['Description', d.assetDescription], ['Additional information', d.additionalInformation],
      ['Privacy acknowledged', `${when(d.privacyAcknowledgedAt)} (${d.privacyNoticeVersion})`], ['Accuracy declared', `${when(d.accuracyDeclaredAt)} (${d.accuracyDeclarationVersion})`],
      ['Marketing consent', d.marketingConsent ? `Given ${when(d.marketingConsentAt)} (${d.marketingConsentTextVersion})${d.marketingConsentWithdrawnAt ? `, withdrawn ${when(d.marketingConsentWithdrawnAt)}` : ''}` : 'Not given'],
      ['Received', when(d.createdAt)], ['First response', when(d.firstResponseAt)], ['Closure', d.closureReason ? `${when(d.closedAt)}: ${d.closureReason}` : ''],
    ]));
    const open_ = !['CONVERTED', 'DECLINED', 'CLOSED'].includes(d.status);
    if (d.sellerReference) parts.push(h('p', {}, 'Seller: ', h('a', { href: `/dashboard/sellers/ui?selected=${encodeURIComponent(d.sellerReference)}`, text: d.sellerReference })));
    else if (['QUALIFICATION', 'AUTHORITY_REVIEW', 'QUALIFIED'].includes(d.status) && d.assignedName) {
      parts.push(h('h3', { text: 'Seller record' }), h('p', { class: 'muted', text: 'Creating a seller copies the contact details from this enquiry. It does not verify authority and does not convert the enquiry.' }),
        h('button', { type: 'button', class: 'button', text: 'Create seller from this enquiry', onclick: async () => { if (await confirmAction(`Create a seller record from ${d.reference}?`, false)) try { await post(d.reference, 'seller', { mode: 'create', expectedVersion: d.version, confirm: true }, 'Seller created.'); } catch (e) { say(e.message, true); } } }));
    }
    if (d.sellerReference && d.status === 'QUALIFIED') {
      parts.push(h('h3', { text: 'Convert to private draft opportunity' }), h('p', { class: 'muted', text: 'Staff-written, neutral title only. Nothing from the enquiry is copied into public fields; the draft is confidential, unreviewed and not public.' }),
        form([field('title', 'Neutral title'), field('role', 'Seller role', opts('role', ['OWNER', 'AUTHORISED_REPRESENTATIVE', 'BROKER_INTERMEDIARY', 'PROFESSIONAL_ADVISER', 'OTHER'])), field('opportunityType', 'Type', opts('opportunityType', ['casino-hotel', 'casino', 'hotel', 'resort', 'gaming-venue', 'other']))], 'Convert', async (v) => {
          if (await confirmAction(`Convert ${d.reference}? The enquiry becomes CONVERTED and a private draft opportunity is created.`, false)) await post(d.reference, 'convert', { title: v.title, role: v.role, opportunityType: v.opportunityType, expectedVersion: d.version, confirm: true }, 'Converted to a private draft opportunity.');
        }));
    }
    if (b.canAssign && open_) {
      parts.push(h('h3', { text: 'Assign owner' }), form([field('assigneeId', 'Broker', h('select', { name: 'assigneeId', required: true }, h('option', { value: '', text: 'Select…' }), ...assignees.filter((a) => ['broker', 'admin', 'super_admin'].includes(a.role)).map((a) => h('option', { value: a.id, text: `${a.displayName || a.email} (${a.role})` }))))], 'Assign', async (v) => {
        if (await confirmAction(`Assign ${d.reference} to the selected broker?`, false)) await post(d.reference, 'assign', { assigneeId: v.assigneeId, expectedVersion: d.version, confirm: true }, 'Owner assigned.');
      }));
    }
    if (b.allowedTransitions.length) {
      parts.push(h('h3', { text: 'Change status' }), h('div', { class: 'se-actions' }, ...b.allowedTransitions.map((to) => h('button', { type: 'button', class: 'button', text: `→ ${label(to)}`, onclick: async () => {
        const needReason = to === 'DECLINED' || to === 'CLOSED';
        const needConfirm = needReason || to === 'QUALIFIED' || to === 'AUTHORITY_REVIEW';
        const r = needConfirm ? await confirmAction(`Move ${d.reference} to ${label(to)}?`, needReason) : true;
        if (r === null) return;
        try { await post(d.reference, 'status', { to, expectedVersion: d.version, confirm: needConfirm || undefined, reason: typeof r === 'string' ? r : undefined }, `Status changed to ${label(to)}.`); } catch (e) { say(e.message, true); }
      } }))));
    }
    if (open_) {
      const items = b.qualificationItems;
      parts.push(h('h3', { text: 'Qualification checklist' }), b.qualification ? h('p', { class: 'muted', text: `Last review: ${label(b.qualification.outcome)} by ${b.qualification.reviewerName} on ${when(b.qualification.createdAt)}. Next action: ${b.qualification.nextAction}. Compliance routed: ${b.qualification.complianceRouted ? 'yes' : 'no'}. Recording a review does not mean KYC, AML or sanctions checks have been completed.` }) : h('p', { class: 'muted', text: 'No review recorded.' }),
        form([...items.map((k) => field(`i_${k}`, label(k), h('select', { name: `i_${k}`, required: true }, ...['YES', 'NO', 'UNKNOWN', 'NOT_APPLICABLE'].map((v) => h('option', { value: v, text: label(v) }))))),
          field('outcome', 'Outcome', opts('outcome', ['PASS', 'NEEDS_MORE_INFO', 'FAIL'])), field('nextAction', 'Next action'),
          h('label', { text: 'Routed to the established legal / KYC / AML process ' }, h('input', { type: 'checkbox', name: 'complianceRouted' }))], 'Record review', async (v) => {
          await post(d.reference, 'qualification', { items: items.map((k) => ({ key: k, answer: v[`i_${k}`] })), outcome: v.outcome, nextAction: v.nextAction, complianceRouted: v.complianceRouted === 'on' }, 'Qualification review recorded.');
        }));
      parts.push(h('h3', { text: 'Follow-ups' }), ...b.followups.map((t) => h('p', {}, `${t.status === 'done' ? '✔ ' : ''}${t.title} · ${label(t.taskType)} · due ${when(t.dueAt)} · ${t.assignedName || 'unassigned'}${t.outcome ? ` · outcome: ${t.outcome}` : ''}${t.escalatedAt ? ' · escalated' : ''} `,
        t.status === 'done' || t.status === 'cancelled' ? null : h('button', { type: 'button', text: 'Complete', onclick: async () => { const r = await confirmAction('Record this follow-up as completed? Enter the outcome.', true); if (r) try { await post(d.reference, `followups/${t.id}/complete`, { outcome: r }, 'Follow-up completed.'); } catch (e) { say(e.message, true); } } }))),
        form([field('title', 'Task'), field('taskType', 'Type', opts('taskType', ['CALL', 'EMAIL', 'REVIEW', 'AUTHORITY_CHASE', 'OTHER'])), field('dueAt', 'Due', h('input', { name: 'dueAt', type: 'datetime-local', required: true })), field('priority', 'Priority', opts('priority', ['normal', 'low', 'high', 'urgent']))], 'Add follow-up', async (v) => {
          await post(d.reference, 'followups', { title: v.title, taskType: v.taskType, priority: v.priority, dueAt: new Date(v.dueAt).toISOString() }, 'Follow-up created.');
        }));
      parts.push(h('h3', { text: 'Record a call, meeting or email' }), h('p', { class: 'muted', text: 'Record a short summary only. Do not paste confidential documents, credentials or financial records.' }),
        form([field('direction', 'Direction', opts('direction', ['OUTBOUND', 'INBOUND'])), field('channel', 'Channel', opts('channel', ['TELEPHONE', 'EMAIL', 'MEETING', 'MESSAGE', 'OTHER'])), field('outcome', 'Outcome', opts('outcome', ['CONNECTED', 'NO_ANSWER', 'LEFT_MESSAGE', 'SENT', 'RECEIVED', 'OTHER'])), field('summary', 'Summary', h('textarea', { name: 'summary', required: true, maxlength: 1000, rows: 3 }))], 'Record', (v) => post(d.reference, 'communications', v, 'Communication recorded.')),
        h('h3', { text: 'Add staff-only note' }), form([field('classification', 'Type', opts('classification', ['GENERAL', 'QUALIFICATION', 'CONFIDENTIALITY', 'AUTHORITY', 'COMPLIANCE'])), field('note', 'Note', h('textarea', { name: 'note', required: true, maxlength: 3000, rows: 4 }))], 'Add note', (v) => post(d.reference, 'notes', v, 'Note added.')));
    }
    if (open_ && d.assignedName) {
      parts.push(h('h3', { text: 'Send follow-up email' }), h('p', { class: 'muted', text: 'You choose the questions, review the exact email, then confirm. Do not include confidential documents or financial detail. No brokerage authority is created by this email.' }),
        form([field('questions', 'Questions (one per line, max 8)', h('textarea', { name: 'questions', required: true, rows: 4 })), field('brokerTitle', 'Your title'), h('label', { text: 'Your telephone (optional) ' }, h('input', { name: 'brokerTelephone', maxlength: 40 }))], 'Preview email', async (v) => {
          const questions = String(v.questions).split('\n').map((q) => q.trim()).filter(Boolean);
          const draft = (await api(`/dashboard/seller-enquiries/${encodeURIComponent(d.reference)}/followup-drafts`, 'POST', { questions, brokerTitle: v.brokerTitle, brokerTelephone: v.brokerTelephone || undefined })).data;
          const ok = await confirmAction(`To: ${draft.recipient}\nSubject: ${draft.subject}\n\n${draft.text}\n\nSend this email exactly as shown?`, false);
          if (ok) { await api(`/dashboard/seller-messages/${draft.id}/send`, 'POST', { expectedVersion: draft.version, confirm: true }); say('Queued. It will show as sent once the email provider accepts it.'); await open(d.reference); }
          else await api(`/dashboard/seller-messages/${draft.id}/cancel`, 'POST', { reason: 'Draft discarded at preview', confirm: true }).catch(() => {});
        }));
    }
    parts.push(...(b.messages.length ? [h('h3', { text: 'Emails sent by staff' }), h('ul', {}, ...b.messages.map((m) => h('li', {}, `${when(m.createdAt)} · ${label(m.kind)} · ${m.status}${m.status === 'SENT' ? ' (accepted by provider; inbox delivery not confirmed)' : ''}${m.jobStatus === 'dead' ? ' · SENDING FAILED (see notification monitor)' : ''}${m.cancelReason ? ` · ${m.cancelReason}` : ''} · ${m.subject} `,
      m.status === 'QUEUED' ? h('button', { type: 'button', text: 'Revoke before sending', onclick: async () => { const r = await confirmAction('Revoke this queued email?', true); if (r) try { await api(`/dashboard/seller-messages/${m.id}/cancel`, 'POST', { reason: r, confirm: true }); say('Revoked.'); await open(d.reference); } catch (e) { say(e.message, true); } } }) : null)))] : []));
    if (d.marketingConsent && !d.marketingConsentWithdrawnAt) parts.push(h('p', {}, 'Marketing consent given. ', h('button', { type: 'button', text: 'Record withdrawal', onclick: async () => { if (await confirmAction('Record that this person withdrew marketing consent?', false)) try { await post(d.reference, 'marketing-withdrawal', {}, 'Withdrawal recorded.'); } catch (e) { say(e.message, true); } } })));
    parts.push(h('p', {}, h('a', { href: `/dashboard/seller-enquiries/${encodeURIComponent(d.reference)}/export`, text: 'Export this record (super admin, MFA)' })));
    const timeline = (title, rows, fmt) => [h('h3', { text: title }), rows.length ? h('ul', {}, ...rows.map((r) => h('li', { text: fmt(r) }))) : h('p', { class: 'muted', text: 'None.' })];
    parts.push(...timeline('Communications', b.communications, (c) => `${when(c.occurredAt)} · ${c.direction} ${label(c.channel)} · ${label(c.outcome)} · ${c.actorName || (c.actorType === 'system' ? 'System' : '')}${c.deliveryStatus === 'ACCEPTED_BY_PROVIDER' ? ' · accepted by provider (inbox delivery not confirmed)' : ''} — ${c.summary}`),
      ...timeline('Staff notes', b.notes, (n) => `${when(n.createdAt)} · ${n.authorName} · ${label(n.classification)} — ${n.note}`),
      ...timeline('Status and assignment history', b.history, (x) => `${when(x.createdAt)} · ${x.actorName} · ${label(x.fromStatus)} → ${label(x.toStatus)}${x.reason ? ` — ${x.reason}` : ''}`),
      ...timeline('Audit trail', b.audit, (a) => `${when(a.createdAt)} · ${a.actorName || a.actorType} · ${a.action}`));
    detailEl.replaceChildren(...parts);
  }

  (async () => {
    try { assignees = (await api('/dashboard/assignees')).data || []; } catch { assignees = []; }
    buildFilters();
    await loadList();
    if (selected) open(selected);
  })();
})();
