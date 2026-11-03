/* Site content tab: navigation, singleton editors, and list editors with add / edit / hide / reorder / delete / reset. */
(() => {
  'use strict';
  const { api, toast, modal, confirmBox } = window.DX || {};
  const F = window.SCFields;
  const navEl = document.querySelector('#sc-nav');
  const mainEl = document.querySelector('#sc-main');
  if (!navEl || !mainEl || !api || !F) return;
  const BASE = '/dashboard/site-content/api';
  let schema = [];
  let current = null;

  const fail = (error) => toast(error.message || 'Something went wrong.', 'error');
  const first = (def, data) => (def.titleField && data[def.titleField]) || def.label;

  async function loadSchema(select) {
    schema = await api(`${BASE}/schema`);
    renderNav();
    if (select) await open(select);
  }

  function renderNav() {
    const groups = [...new Set(schema.map((s) => s.group))];
    navEl.innerHTML = groups.map((group) => `<p class="sc-nav-group">${F.esc(group)}</p>${schema
      .filter((s) => s.group === group)
      .map((s) => `<button type="button" class="sc-nav-btn${current === s.key ? ' is-active' : ''}" data-key="${F.esc(s.key)}">${F.esc(s.label)}${s.customised ? '<span class="sc-dot" title="Customised"></span>' : ''}</button>`)
      .join('')}`).join('');
    navEl.querySelectorAll('[data-key]').forEach((b) => b.addEventListener('click', () => open(b.dataset.key).catch(fail)));
  }

  async function open(key) {
    current = key;
    const def = await api(`${BASE}/${key}`);
    renderNav();
    if (def.kind === 'singleton') renderSingleton(def);
    else renderList(def);
  }

  function header(def, extra = '') {
    return `<header class="sc-head"><div><h2>${F.esc(def.label)}</h2><p class="muted">${F.esc(def.help)}</p></div><div class="sc-head-actions">${extra}${def.customised ? '<button type="button" class="dx-btn" data-reset>Reset to built-in</button>' : ''}</div></header>${def.customised ? '' : '<p class="sc-banner">Showing the built-in content. Saving or editing copies it into your site content so you can change it.</p>'}`;
  }

  async function reset(def) {
    const ok = await confirmBox({ title: `Reset ${def.label}?`, message: 'Your changes to this block are removed and the built-in content returns. This cannot be undone.', confirmLabel: 'Reset', danger: true });
    if (!ok) return;
    await api(`${BASE}/${def.key}`, 'DELETE');
    toast('Reset to built-in content.');
    await loadSchema(def.key);
  }

  function renderSingleton(def) {
    const data = def.items[0] ? def.items[0].data : {};
    mainEl.innerHTML = `${header(def)}<form class="sc-form" id="sc-form">${F.render(def.fields, data)}<div class="sc-actions"><button type="submit" class="dx-btn dx-btn-primary">Save</button><a class="dx-btn" href="/" target="_blank" rel="noopener">View site</a></div></form>`;
    const form = mainEl.querySelector('#sc-form');
    F.wire(form);
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      try {
        await api(`${BASE}/${def.key}/singleton`, 'PUT', { data: F.read(form, def.fields) });
        toast('Saved. Public pages refresh within a minute.');
        await loadSchema(def.key);
      } catch (error) { fail(error); }
    });
    mainEl.querySelector('[data-reset]')?.addEventListener('click', () => reset(def).catch(fail));
  }

  function renderList(def) {
    const rows = def.items.map((item, index) => `<li class="sc-row${item.enabled ? '' : ' is-off'}" data-id="${F.esc(item.id)}"><span class="sc-row-title">${F.esc(first(def, item.data))}${item.enabled ? '' : ' <em>(hidden)</em>'}${item.data.type ? ` <small>${F.esc(item.data.type)}</small>` : ''}</span><span class="sc-row-actions"><button type="button" class="dx-btn" data-act="up" ${index === 0 ? 'disabled' : ''} aria-label="Move up">↑</button><button type="button" class="dx-btn" data-act="down" ${index === def.items.length - 1 ? 'disabled' : ''} aria-label="Move down">↓</button><button type="button" class="dx-btn" data-act="toggle">${item.enabled ? 'Hide' : 'Show'}</button><button type="button" class="dx-btn" data-act="edit">Edit</button><button type="button" class="dx-btn dx-btn-danger" data-act="delete">Delete</button></span></li>`).join('');
    const addBtn = `<button type="button" class="dx-btn dx-btn-primary" data-add ${def.items.length >= def.maxItems ? 'disabled' : ''}>Add item</button>`;
    mainEl.innerHTML = `${header(def, addBtn)}<ul class="sc-list">${rows || '<li class="sc-empty">Nothing here yet.</li>'}</ul>`;
    mainEl.querySelector('[data-reset]')?.addEventListener('click', () => reset(def).catch(fail));
    mainEl.querySelector('[data-add]')?.addEventListener('click', () => editor(def, null));
    mainEl.querySelectorAll('.sc-row').forEach((row) => row.addEventListener('click', (event) => {
      const act = event.target.closest('[data-act]')?.dataset.act;
      if (act) rowAction(def, row.dataset.id, act).catch(fail);
    }));
  }

  async function ensureCustomised(def) {
    if (!def.customised) {
      await api(`${BASE}/${def.key}/customise`, 'POST');
      return api(`${BASE}/${def.key}`);
    }
    return def;
  }

  async function rowAction(def, id, act) {
    const position = def.items.findIndex((i) => i.id === id);
    const live = await ensureCustomised(def);
    const items = live.items;
    const index = position;
    const item = items[index];
    if (!item) throw new Error('Item not found. Reload the page.');
    if (act === 'edit') return editor(live, item);
    if (act === 'delete') {
      const ok = await confirmBox({ title: 'Delete this item?', message: `"${first(def, item.data)}" is removed from the site.`, confirmLabel: 'Delete', danger: true });
      if (ok) await api(`${BASE}/${def.key}/items/${item.id}`, 'DELETE');
    } else if (act === 'toggle') {
      await api(`${BASE}/${def.key}/items/${item.id}`, 'PUT', { enabled: !item.enabled });
    } else {
      const to = act === 'up' ? index - 1 : index + 1;
      const ids = items.map((i) => i.id);
      [ids[index], ids[to]] = [ids[to], ids[index]];
      await api(`${BASE}/${def.key}/reorder`, 'POST', { ids });
    }
    await loadSchema(def.key);
  }

  function editor(def, item) {
    const dialog = modal(item ? `Edit ${def.label}` : `Add to ${def.label}`, `<form id="sc-item-form" class="sc-form">${F.render(def.fields, item ? item.data : {})}<label class="sc-field sc-field-toggle"><span class="sc-check"><input type="checkbox" name="__enabled" ${!item || item.enabled ? 'checked' : ''}> <span>Visible on the site</span></span></label><p class="sc-error" role="alert"></p><div class="dx-actions"><button type="button" class="dx-btn" data-close>Cancel</button><button type="submit" class="dx-btn dx-btn-primary">Save</button></div></form>`, { wide: true });
    const form = dialog.el.querySelector('#sc-item-form');
    F.wire(form);
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const body = { data: F.read(form, def.fields), enabled: form.elements.__enabled.checked };
      try {
        if (item) await api(`${BASE}/${def.key}/items/${item.id}`, 'PUT', body);
        else await api(`${BASE}/${def.key}/items`, 'POST', body);
        dialog.close();
        toast('Saved.');
        await loadSchema(def.key);
      } catch (error) { form.querySelector('.sc-error').textContent = error.message; }
    });
  }

  loadSchema(new URLSearchParams(location.search).get('c') || 'hero').catch(fail);
})();
