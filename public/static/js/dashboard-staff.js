(() => {
  const { esc, api, toast, modal, badge, fmtDate, debounce, generatePassword, copy } = window.DX;
  const roles = ['super_admin', 'admin', 'editor', 'broker', 'publisher', 'auditor'];
  const roleLabel = (r) => r.replace('_', ' ');
  const list = document.getElementById('staff-list');
  const search = document.getElementById('staff-search');
  const tabs = document.getElementById('staff-tabs');
  let rows = [];
  let tab = 'all';

  const passwordState = (u) =>
    !u.hasPassword
      ? badge('Invite pending', 'warn')
      : u.mustChange
        ? badge('Temporary - must change', 'warn')
        : badge('Set', 'ok');

  function visible() {
    const q = (search.value || '').trim().toLowerCase();
    return rows.filter(
      (u) =>
        (tab === 'all' || u.status === tab) &&
        (!q || `${u.displayName} ${u.email} ${u.role}`.toLowerCase().includes(q)),
    );
  }

  function render() {
    const counts = { all: rows.length, active: 0, suspended: 0 };
    rows.forEach((u) => (counts[u.status] = (counts[u.status] || 0) + 1));
    tabs.querySelectorAll('.dx-tab').forEach((b) => {
      b.setAttribute('aria-selected', String(b.dataset.tab === tab));
      b.querySelector('.dx-count').textContent = counts[b.dataset.tab] ?? 0;
    });
    const items = visible();
    list.innerHTML = items.length
      ? `<table class="dx-table"><thead><tr><th>Person</th><th>Role</th><th>Status</th><th>Password</th><th>Added</th><th></th></tr></thead><tbody>${items
          .map(
            (u) =>
              `<tr><td><span class="dx-primary">${esc(u.displayName)}${u.isSelf ? ' <small>(you)</small>' : ''}</span><span class="dx-secondary">${esc(u.email)}</span></td><td>${badge(roleLabel(u.role), 'info')}</td><td>${badge(u.status)}</td><td>${passwordState(u)}</td><td>${fmtDate(u.createdAt)}</td><td><div class="dx-row-actions"><button class="dx-btn dx-btn-sm" data-act="edit" data-id="${esc(u.id)}">Edit</button><button class="dx-btn dx-btn-sm" data-act="password" data-id="${esc(u.id)}">Password</button>${u.isSelf ? '' : `<button class="dx-btn dx-btn-sm ${u.status === 'active' ? 'dx-btn-ghost-danger' : ''}" data-act="toggle" data-id="${esc(u.id)}">${u.status === 'active' ? 'Suspend' : 'Activate'}</button>`}</div></td></tr>`,
          )
          .join('')}</tbody></table>`
      : '<div class="dx-empty">No staff accounts match.</div>';
  }

  async function load() {
    try {
      rows = await api('/dashboard/staff');
      render();
    } catch (e) {
      list.innerHTML = `<div class="dx-empty">${esc(e.message)}</div>`;
    }
  }

  const roleOptions = (current) =>
    roles
      .map(
        (r) => `<option value="${r}"${r === current ? ' selected' : ''}>${roleLabel(r)}</option>`,
      )
      .join('');

  function secretView(dlg, title, email, password, extra = '') {
    dlg.el.querySelector('h2').textContent = title;
    dlg.el.querySelector('.dx-dialog-body').innerHTML =
      `<div class="dx-form"><p class="dx-confirm-text">Share this temporary password with <strong>${esc(email)}</strong> through a secure channel. It is shown only once.</p><div class="dx-secret"><span id="secret">${esc(password)}</span><button type="button" class="dx-btn dx-btn-sm" id="copy-secret">Copy</button></div><div class="dx-note dx-note-warn">They must choose a new password the first time they sign in. Any existing sessions were signed out.${extra}</div><div class="dx-actions"><button type="button" class="dx-btn dx-btn-primary" data-close>Done</button></div></div>`;
    dlg.el.querySelector('#copy-secret').addEventListener('click', () => copy(password));
  }

  function openEdit(u) {
    const dlg = modal(
      'Edit staff account',
      `<form class="dx-form" id="edit-form"><label class="dx-field">Full name<input name="displayName" value="${esc(u.displayName)}" minlength="2" maxlength="120" required></label><label class="dx-field">Email<input name="email" type="email" value="${esc(u.email)}" maxlength="254" required${u.isSelf ? ' disabled' : ''}>${u.isSelf ? '<small>Ask another super administrator to change your email.</small>' : '<small>Changing the email signs the person out everywhere.</small>'}</label><div class="dx-row"><label class="dx-field">Role<select name="role"${u.isSelf ? ' disabled' : ''}>${roleOptions(u.role)}</select></label><label class="dx-field">Status<select name="status"${u.isSelf ? ' disabled' : ''}><option value="active"${u.status === 'active' ? ' selected' : ''}>Active</option><option value="suspended"${u.status === 'suspended' ? ' selected' : ''}>Suspended</option></select></label></div><div class="dx-actions"><button type="button" class="dx-btn" data-close>Cancel</button><button type="submit" class="dx-btn dx-btn-primary">Save changes</button></div></form>`,
    );
    dlg.el.querySelector('#edit-form').addEventListener('submit', async (event) => {
      event.preventDefault();
      const f = new FormData(event.currentTarget);
      const body = { displayName: f.get('displayName') };
      if (!u.isSelf) {
        body.email = f.get('email');
        body.role = f.get('role');
        body.status = f.get('status');
      }
      try {
        await api(`/dashboard/staff/${u.id}`, 'PATCH', body);
        toast('Staff account updated.');
        dlg.close();
        await load();
      } catch (e) {
        toast(e.message, 'error');
      }
    });
  }

  function openPassword(u) {
    const dlg = modal(
      `Password for ${u.displayName}`,
      u.isSelf
        ? '<p class="dx-confirm-text">Use <a href="/admin/change-password">Change password</a> to update your own password.</p>'
        : `<div class="dx-form"><div class="dx-note">A temporary password signs the person out everywhere and forces them to choose a new password at their next sign-in.</div><label class="dx-field">Temporary password<div class="dx-input-group"><input id="tmp" type="text" autocomplete="off" minlength="12" maxlength="200" placeholder="Leave empty to generate one"><button type="button" class="dx-btn" id="gen">Generate</button></div><small>At least 12 characters, with letters and numbers.</small></label><div class="dx-actions"><button type="button" class="dx-btn" id="send-link">Email a reset link instead</button><button type="button" class="dx-btn dx-btn-primary" id="set-tmp">Set temporary password</button></div></div>`,
    );
    if (u.isSelf) return;
    const input = dlg.el.querySelector('#tmp');
    dlg.el
      .querySelector('#gen')
      .addEventListener('click', () => (input.value = generatePassword()));
    dlg.el.querySelector('#set-tmp').addEventListener('click', async () => {
      try {
        const r = await api(`/dashboard/staff/${u.id}/temporary-password`, 'POST', {
          password: input.value.trim() || undefined,
        });
        secretView(dlg, 'Temporary password set', r.email, r.temporaryPassword);
        await load();
      } catch (e) {
        toast(e.message, 'error');
      }
    });
    dlg.el.querySelector('#send-link').addEventListener('click', async () => {
      try {
        const r = await api(`/dashboard/staff/${u.id}/reset-password`, 'POST', {});
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

  function openCreate() {
    const dlg = modal(
      'Add staff member',
      `<form class="dx-form" id="create-form"><label class="dx-field">Full name<input name="displayName" minlength="2" maxlength="120" required></label><label class="dx-field">Work email<input name="email" type="email" maxlength="254" required></label><label class="dx-field">Role<select name="role">${roleOptions('editor')}</select></label><label class="dx-field">Temporary password (optional)<div class="dx-input-group"><input name="temporaryPassword" id="new-tmp" type="text" autocomplete="off" minlength="12" maxlength="200" placeholder="Empty = email a set-password link"><button type="button" class="dx-btn" id="gen-new">Generate</button></div><small>With a temporary password they must change it at first sign-in.</small></label><div class="dx-actions"><button type="button" class="dx-btn" data-close>Cancel</button><button type="submit" class="dx-btn dx-btn-primary">Create account</button></div></form>`,
    );
    const input = dlg.el.querySelector('#new-tmp');
    dlg.el
      .querySelector('#gen-new')
      .addEventListener('click', () => (input.value = generatePassword()));
    dlg.el.querySelector('#create-form').addEventListener('submit', async (event) => {
      event.preventDefault();
      const body = Object.fromEntries(new FormData(event.currentTarget));
      if (!body.temporaryPassword) delete body.temporaryPassword;
      try {
        const r = await api('/dashboard/staff', 'POST', body);
        await load();
        if (body.temporaryPassword)
          secretView(dlg, 'Account created', body.email, body.temporaryPassword);
        else {
          toast(
            r.invited
              ? 'Account created. Set-password email queued.'
              : 'Account created. Email delivery is not configured, so reset their password with a temporary one.',
          );
          dlg.close();
        }
      } catch (e) {
        toast(e.message, 'error');
      }
    });
  }

  list.addEventListener('click', async (event) => {
    const button = event.target.closest('[data-act]');
    if (!button) return;
    const u = rows.find((r) => r.id === button.dataset.id);
    if (!u) return;
    if (button.dataset.act === 'edit') openEdit(u);
    else if (button.dataset.act === 'password') openPassword(u);
    else if (button.dataset.act === 'toggle') {
      const next = u.status === 'active' ? 'suspended' : 'active';
      try {
        await api(`/dashboard/staff/${u.id}`, 'PATCH', { status: next });
        toast(next === 'active' ? 'Account activated.' : 'Account suspended and signed out.');
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
  document.getElementById('staff-add').addEventListener('click', openCreate);
  load();
})();
