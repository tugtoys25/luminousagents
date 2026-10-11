(() => {
  const { esc, api, toast, modal, badge, fmtDate, debounce, generatePassword, copy } = window.DX;
  const list = document.getElementById('buyers');
  const search = document.getElementById('buyer-search');
  const tabs = document.getElementById('buyer-tabs');
  let rows = [];
  let tab = 'invited';
  const label = { invited: 'Pending approval', active: 'Active', suspended: 'Suspended' };

  const passwordState = (u) =>
    !u.hasPassword
      ? badge('None yet', 'muted')
      : u.mustChange
        ? badge('Temporary - must change', 'warn')
        : badge('Set', 'ok');

  const visible = () => {
    const q = (search.value || '').trim().toLowerCase();
    return rows.filter(
      (u) =>
        (tab === 'all' || u.status === tab) &&
        (!q || `${u.displayName} ${u.email} ${u.companyName || ''}`.toLowerCase().includes(q)),
    );
  };

  function actions(u) {
    const id = esc(u.id);
    const primary =
      u.status === 'invited'
        ? `<button class="dx-btn dx-btn-sm dx-btn-primary" data-act="status" data-to="active" data-id="${id}">Approve</button>`
        : u.status === 'suspended'
          ? `<button class="dx-btn dx-btn-sm" data-act="status" data-to="active" data-id="${id}">Reactivate</button>`
          : `<button class="dx-btn dx-btn-sm dx-btn-ghost-danger" data-act="status" data-to="suspended" data-id="${id}">Suspend</button>`;
    const reject =
      u.status === 'invited'
        ? `<button class="dx-btn dx-btn-sm dx-btn-ghost-danger" data-act="status" data-to="suspended" data-id="${id}">Decline</button>`
        : '';
    return `<div class="dx-row-actions">${primary}${reject}<button class="dx-btn dx-btn-sm" data-act="password" data-id="${id}">Password</button></div>`;
  }

  function render() {
    const counts = { all: rows.length, invited: 0, active: 0, suspended: 0 };
    rows.forEach((u) => (counts[u.status] = (counts[u.status] || 0) + 1));
    tabs.querySelectorAll('.dx-tab').forEach((b) => {
      b.setAttribute('aria-selected', String(b.dataset.tab === tab));
      b.querySelector('.dx-count').textContent = counts[b.dataset.tab] ?? 0;
    });
    const items = visible();
    list.innerHTML = items.length
      ? `<table class="dx-table"><thead><tr><th>Buyer</th><th>Company</th><th>Status</th><th>Password</th><th>Registered</th><th></th></tr></thead><tbody>${items
          .map(
            (u) =>
              `<tr><td><span class="dx-primary">${esc(u.displayName)}</span><span class="dx-secondary">${esc(u.email)}</span></td><td><span class="dx-primary">${esc(u.companyName || '–')}</span><span class="dx-secondary">${esc(u.roleTitle || '')}</span></td><td>${badge(label[u.status] || u.status, u.status)}</td><td>${passwordState(u)}</td><td>${fmtDate(u.createdAt)}</td><td>${actions(u)}</td></tr>`,
          )
          .join('')}</tbody></table>`
      : `<div class="dx-empty">${tab === 'invited' ? 'No registrations are waiting for approval.' : 'No buyers match.'}</div>`;
  }

  async function load() {
    try {
      rows = await api('/dashboard/buyers');
      if (tab === 'invited' && !rows.some((u) => u.status === 'invited')) tab = 'active';
      render();
    } catch (e) {
      list.innerHTML = `<div class="dx-empty">${esc(e.message)}</div>`;
    }
  }

  function secretView(dlg, title, email, password) {
    dlg.el.querySelector('h2').textContent = title;
    dlg.el.querySelector('.dx-dialog-body').innerHTML =
      `<div class="dx-form"><p class="dx-confirm-text">Share this temporary password with <strong>${esc(email)}</strong> through a secure channel. It is shown only once.</p><div class="dx-secret"><span>${esc(password)}</span><button type="button" class="dx-btn dx-btn-sm" id="copy-secret">Copy</button></div><div class="dx-note dx-note-warn">They must choose a new password at their next sign-in at <strong>/account</strong>. Existing sessions were signed out.</div><div class="dx-actions"><button type="button" class="dx-btn dx-btn-primary" data-close>Done</button></div></div>`;
    dlg.el.querySelector('#copy-secret').addEventListener('click', () => copy(password));
  }

  function openPassword(u) {
    const dlg = modal(
      `Password for ${u.displayName}`,
      `<div class="dx-form"><div class="dx-note">A temporary password signs the buyer out everywhere and forces a new password at their next sign-in.</div><label class="dx-field">Temporary password<div class="dx-input-group"><input id="tmp" type="text" autocomplete="off" minlength="12" maxlength="200" placeholder="Leave empty to generate one"><button type="button" class="dx-btn" id="gen">Generate</button></div><small>At least 12 characters, with letters and numbers.</small></label><div class="dx-actions">${u.status === 'active' ? '<button type="button" class="dx-btn" id="send-link">Email a reset link instead</button>' : ''}<button type="button" class="dx-btn dx-btn-primary" id="set-tmp">Set temporary password</button></div></div>`,
    );
    const input = dlg.el.querySelector('#tmp');
    dlg.el
      .querySelector('#gen')
      .addEventListener('click', () => (input.value = generatePassword()));
    dlg.el.querySelector('#set-tmp').addEventListener('click', async () => {
      try {
        const r = await api(`/dashboard/buyers/${u.id}/temporary-password`, 'POST', {
          password: input.value.trim() || undefined,
        });
        secretView(dlg, 'Temporary password set', r.email, r.temporaryPassword);
        await load();
      } catch (e) {
        toast(e.message, 'error');
      }
    });
    const send = dlg.el.querySelector('#send-link');
    if (send)
      send.addEventListener('click', async () => {
        try {
          const r = await api(`/dashboard/buyers/${u.id}/reset-password`, 'POST', {});
          toast(
            r.emailQueued
              ? 'Reset link queued by email.'
              : 'Email delivery is not configured. Set a temporary password instead.',
            r.emailQueued ? 'ok' : 'error',
          );
          if (r.emailQueued) dlg.close();
        } catch (e) {
          toast(e.message, 'error');
        }
      });
  }

  function openAdd() {
    const dlg = modal(
      'Add an approved buyer',
      `<form class="dx-form" id="add-form"><label class="dx-field">Full name<input name="displayName" minlength="2" maxlength="120" required></label><label class="dx-field">Business email<input name="email" type="email" maxlength="254" required></label><div class="dx-note">The buyer is approved immediately and receives a set-password email. Confidential documents still require an approved NDA.</div><div class="dx-actions"><button type="button" class="dx-btn" data-close>Cancel</button><button type="submit" class="dx-btn dx-btn-primary">Add buyer</button></div></form>`,
    );
    dlg.el.querySelector('#add-form').addEventListener('submit', async (event) => {
      event.preventDefault();
      try {
        const r = await api(
          '/dashboard/buyers/provision',
          'POST',
          Object.fromEntries(new FormData(event.currentTarget)),
        );
        toast(
          r.inviteQueued
            ? 'Buyer added. Invitation email queued.'
            : 'Buyer added. Email is not configured: set a temporary password.',
        );
        dlg.close();
        tab = 'active';
        await load();
      } catch (e) {
        toast(e.message, 'error');
      }
    });
  }

  list.addEventListener('click', async (event) => {
    const b = event.target.closest('[data-act]');
    if (!b) return;
    const u = rows.find((r) => r.id === b.dataset.id);
    if (!u) return;
    if (b.dataset.act === 'password') return openPassword(u);
    if (b.dataset.act === 'status') {
      const to = b.dataset.to;
      if (
        to === 'suspended' &&
        !(await window.DX.confirmBox({
          title: u.status === 'invited' ? 'Decline registration?' : 'Suspend buyer?',
          message: `${u.displayName} will not be able to sign in${u.status === 'invited' ? '' : ' and will be signed out'}.`,
          confirmLabel: u.status === 'invited' ? 'Decline' : 'Suspend',
          danger: true,
        }))
      )
        return;
      try {
        await api(`/dashboard/buyers/${u.id}`, 'PATCH', { status: to });
        toast(to === 'active' ? 'Buyer approved.' : 'Buyer access updated.');
        await load();
      } catch (e) {
        toast(e.message, 'error');
      }
    }
  });
  tabs.addEventListener('click', (event) => {
    const b = event.target.closest('.dx-tab');
    if (!b) return;
    tab = b.dataset.tab;
    render();
  });
  search.addEventListener('input', debounce(render, 120));
  document.getElementById('buyer-add').addEventListener('click', openAdd);
  load();
})();
