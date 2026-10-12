/* global module, HTMLTextAreaElement */
/*
 * Visual editors for the dashboard fields that used to need JSON.
 *
 * Each editor replaces one JSON textarea with plain forms: add, edit, reorder and
 * remove. The original textarea stays in the page (hidden) and always holds the
 * matching JSON, so the existing Save buttons and server checks keep working.
 */
(() => {
  'use strict';

  /* ---------- pure helpers (also exercised by the unit tests) ---------- */
  const isSitePath = (value) => value.startsWith('/') && !value.startsWith('//');
  const isHttps = (value) => /^https:\/\//i.test(value);
  const text = (value) => (typeof value === 'string' ? value : '');
  const objects = (raw) => (Array.isArray(raw) ? raw.filter((x) => x && typeof x === 'object') : []);

  function slugName(label, taken) {
    let base = String(label)
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '');
    if (!base) base = 'field';
    if (!/^[a-z]/.test(base)) base = `f_${base}`;
    base = base.slice(0, 36);
    let name = base;
    let n = 2;
    while (taken.has(name)) name = `${base}_${n++}`;
    return name;
  }

  const TYPE_LABELS = {
    text: 'Short text',
    email: 'Email address',
    tel: 'Phone number',
    textarea: 'Long text (paragraph)',
    select: 'Dropdown list',
  };
  const splitOptions = (value) =>
    [...new Set(String(value).split(/\r?\n/).map((line) => line.trim()).filter(Boolean))];

  /* ---------- what each editor edits ---------- */
  const KINDS = {
    links: {
      itemName: 'Link',
      limit: 20,
      min: 0,
      addLabel: 'Add a link',
      blank: () => ({ label: '', url: '' }),
      load: (raw) => objects(raw).map((o) => ({ label: text(o.label), url: text(o.url) })),
      isEmpty: (it) => !it.label.trim() && !it.url.trim(),
      out: (it) => ({ label: it.label.trim().slice(0, 80), url: it.url.trim() }),
      problems(it) {
        const p = {};
        if (!it.label.trim()) p.label = 'Add the text people will see.';
        const url = it.url.trim();
        if (!url) p.url = 'Choose where this link goes.';
        else if (!isSitePath(url) && !isHttps(url))
          p.url = 'Start with / for a page on this site (like /contact) or https:// for another website.';
        return p;
      },
      fields: (it, ui) => [
        ui.grid(
          ui.field('label', 'Link text', ui.input(it.label, { maxlength: 80, placeholder: 'e.g. Contact us' })),
          ui.field(
            'url',
            'Goes to',
            ui.input(it.url, { maxlength: 300, placeholder: '/contact or https://…', list: 'je-pages' }),
            'Pick a page from the list, or type a web address.',
          ),
        ),
      ],
    },

    sections: {
      itemName: 'Section',
      limit: 20,
      min: 0,
      addLabel: 'Add a section',
      blank: () => ({ title: '', body: '', url: '' }),
      load: (raw) =>
        objects(raw).map((o) => ({ title: text(o.title), body: text(o.body), url: text(o.url) })),
      isEmpty: (it) => !it.title.trim() && !it.body.trim() && !it.url.trim(),
      out(it) {
        const o = { title: it.title.trim().slice(0, 160), body: it.body.trim().slice(0, 1000) };
        if (it.url.trim()) o.url = it.url.trim();
        return o;
      },
      problems(it) {
        const p = {};
        if (!it.title.trim() && !it.body.trim()) p.title = 'Add a heading or some text.';
        const url = it.url.trim();
        if (url && !isSitePath(url)) p.url = 'Use a page on this site, starting with / (for example /contact).';
        return p;
      },
      fields: (it, ui) => [
        ui.field('title', 'Heading', ui.input(it.title, { maxlength: 160, placeholder: 'e.g. Why Mayfair' })),
        ui.field(
          'body',
          'Text',
          ui.textarea(it.body, { maxlength: 1000, rows: 4 }),
          '',
          (value) => `${value.length} / 1000`,
        ),
        ui.field(
          'url',
          'Link to a page (optional)',
          ui.input(it.url, { maxlength: 300, placeholder: '/contact', list: 'je-pages' }),
          'Adds a link under the text. Leave empty for none.',
        ),
      ],
    },

    formFields: {
      itemName: 'Field',
      limit: 20,
      min: 1,
      addLabel: 'Add a field',
      blank: () => ({
        name: '',
        label: '',
        type: 'text',
        required: false,
        optionsText: '',
        locked: false,
        nameEdited: false,
      }),
      load: (raw) =>
        objects(raw).map((o) => ({
          name: text(o.name),
          label: text(o.label),
          type: Object.hasOwn(TYPE_LABELS, o.type) ? o.type : 'text',
          required: o.required === true,
          optionsText: Array.isArray(o.options) ? o.options.filter((x) => typeof x === 'string').join('\n') : '',
          locked: true,
          nameEdited: true,
        })),
      isEmpty: (it) => !it.label.trim() && !it.optionsText.trim() && !it.locked,
      // New fields get their internal ID from the label, so nobody has to type one.
      normalise(items) {
        const taken = new Set();
        for (const it of items) if (it.locked || it.nameEdited) taken.add(it.name);
        for (const it of items) {
          if (it.locked || it.nameEdited) continue;
          it.name = it.label.trim() ? slugName(it.label, taken) : '';
          if (it.name) taken.add(it.name);
        }
      },
      out(it) {
        const o = {
          name: it.name,
          label: it.label.trim().slice(0, 80),
          type: it.type,
          required: Boolean(it.required),
        };
        if (it.type === 'select') o.options = splitOptions(it.optionsText).slice(0, 20);
        return o;
      },
      problems(it, items) {
        const p = {};
        if (!it.label.trim()) p.label = 'Add the question or label people will see.';
        if (!/^[a-z][a-z0-9_]{0,39}$/.test(it.name))
          p.name = 'Use lowercase letters, numbers and underscores, starting with a letter.';
        else if (items.some((other) => other !== it && other.name === it.name))
          p.name = 'Another field already uses this ID.';
        if (it.type === 'select') {
          const options = splitOptions(it.optionsText);
          if (!options.length) p.optionsText = 'Add at least one choice, one per line.';
          else if (options.length > 20) p.optionsText = 'Use at most 20 choices.';
          else if (options.some((o) => o.length > 80)) p.optionsText = 'Keep each choice under 80 characters.';
        }
        return p;
      },
      fields: (it, ui) => [
        ui.grid(
          ui.field('label', 'Question or label', ui.input(it.label, { maxlength: 80, placeholder: 'e.g. Phone number' })),
          ui.field('type', 'Answer type', ui.select(it.type, TYPE_LABELS)),
        ),
        ui.check('required', 'Required: people must answer this', it.required),
        ui.field(
          'optionsText',
          'Choices (one per line)',
          ui.textarea(it.optionsText, { rows: 4, placeholder: 'Option one\nOption two' }),
          '',
          null,
          { showWhen: () => it.type === 'select', slot: 'options' },
        ),
        it.locked
          ? ui.note(`Field ID: ${it.name} (kept so earlier submissions still match).`)
          : ui.details(
              'Advanced: field ID',
              ui.field(
                'name',
                'Field ID',
                ui.input(it.name, { maxlength: 40 }),
                'Created from the label automatically. Only change it if you need a specific ID.',
              ),
            ),
      ],
    },
  };

  const BY_NAME = {
    header_navigation: {
      kind: 'links',
      heading: 'Top menu links',
      help: 'The links across the top of every page. Leave this empty to keep the standard menu.',
    },
    footer_navigation: {
      kind: 'links',
      heading: 'Footer links',
      help: 'The "Information" links in the footer. Leave this empty to keep the standard links.',
    },
    homepage_sections: {
      kind: 'sections',
      heading: 'Extra homepage sections',
      help: 'Blocks shown at the bottom of the homepage under the label "More from Mayfair". Leave empty to show none.',
    },
    geo_sections: {
      kind: 'sections',
      heading: 'Market sections',
      help: 'Blocks shown at the bottom of the homepage under the label "Our markets". Leave empty to show none.',
    },
    fieldsJson: {
      kind: 'formFields',
      heading: 'Form fields',
      help: 'The questions visitors answer. Add, reorder or remove fields. People see them in this order.',
    },
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { KINDS, BY_NAME, slugName, splitOptions, isSitePath, isHttps };
    return;
  }

  /* ---------- DOM ---------- */
  const valueProp = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value');
  const editors = [];

  function h(tag, props = {}, ...kids) {
    const el = document.createElement(tag);
    for (const [key, value] of Object.entries(props)) {
      if (value === undefined || value === null || value === false) continue;
      if (key === 'class') el.className = value;
      else if (key === 'text') el.textContent = value;
      else if (key.startsWith('data-') || key.startsWith('aria-') || key === 'role')
        el.setAttribute(key, String(value));
      else if (['maxlength', 'placeholder', 'list', 'rows', 'type', 'title', 'autocomplete'].includes(key))
        el.setAttribute(key, String(value));
      else el[key] = value;
    }
    for (const kid of kids.flat()) if (kid !== null && kid !== undefined) el.append(kid);
    return el;
  }

  let pageListReady = false;
  function ensurePageList() {
    if (pageListReady) return;
    pageListReady = true;
    const list = h('datalist', { id: 'je-pages' });
    document.body.append(list);
    const add = (value, label) => {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = label;
      list.append(option);
    };
    add('/', 'Home page');
    const get = (url) =>
      fetch(url, { credentials: 'same-origin' })
        .then((r) => (r.ok ? r.json() : { data: [] }))
        .catch(() => ({ data: [] }));
    Promise.all([get('/dashboard/pages/defaults'), get('/dashboard/pages'), get('/dashboard/forms')]).then(
      ([defaults, pages, forms]) => {
        const seen = new Set(['/']);
        const push = (value, label) => {
          if (typeof value !== 'string' || !isSitePath(value) || seen.has(value)) return;
          seen.add(value);
          add(value, String(label || value).slice(0, 80));
        };
        for (const x of defaults.data || []) push(x.path, x.title);
        for (const x of pages.data || []) if (x.status === 'published') push(x.publicPath, x.title);
        for (const x of forms.data || []) if (x.status === 'published') push(`/forms/${x.slug}`, x.title);
      },
    );
  }

  function mount(textarea, spec) {
    if (textarea.dataset.jeMounted) return;
    textarea.dataset.jeMounted = '1';
    const kind = KINDS[spec.kind];
    const labelEl = textarea.closest('label') || textarea;
    textarea.removeAttribute('required');
    if (spec.kind !== 'formFields') ensurePageList();

    let items = [];
    let showAll = false;

    const list = h('div', { class: 'je-list' });
    const add = h('button', { type: 'button', class: 'dx-btn', text: `+ ${kind.addLabel}` });
    const status = h('p', { class: 'je-hint', role: 'status' });
    const root = h(
      'div',
      { class: 'je', 'data-je-kind': spec.kind },
      h('div', { class: 'je-intro' }, h('strong', { text: spec.heading }), h('p', { class: 'je-help', text: spec.help })),
      list,
      h('div', { class: 'je-actions' }, add, status),
    );
    labelEl.insertAdjacentElement('afterend', root);
    labelEl.style.display = 'none';

    const read = (raw) => {
      let parsed = [];
      try {
        parsed = JSON.parse(raw || '[]');
      } catch {
        parsed = [];
      }
      items = kind.load(parsed);
      kind.normalise?.(items);
    };
    const serialize = () => items.filter((it) => !kind.isEmpty(it)).map(kind.out);
    const commit = () => {
      kind.normalise?.(items);
      valueProp.set.call(textarea, JSON.stringify(serialize()));
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    };
    const problemsFor = () =>
      items.map((it) => (kind.isEmpty(it) ? {} : kind.problems(it, items.filter((x) => !kind.isEmpty(x)))));

    function refresh() {
      const all = problemsFor();
      for (const card of list.children) {
        const meta = card._je;
        if (!meta) continue;
        const found = all[items.indexOf(meta.item)] || {};
        for (const [key, err] of Object.entries(meta.errs)) {
          const message = (showAll || meta.item._touched?.has(key)) && found[key] ? found[key] : '';
          err.textContent = message;
          err.hidden = !message;
          const input = meta.inputs[key];
          if (input) input.setAttribute('aria-invalid', message ? 'true' : 'false');
        }
        const auto = meta.inputs.name;
        if (auto && !meta.item.nameEdited && auto.value !== meta.item.name) auto.value = meta.item.name;
        card.classList.toggle('je-bad', showAll && Object.keys(found).length > 0);
        for (const [slot, rule] of Object.entries(meta.visibility)) {
          meta.slots[slot].style.display = rule() ? '' : 'none';
        }
      }
      add.disabled = items.length >= kind.limit;
      status.textContent = items.length >= kind.limit ? `Up to ${kind.limit} items.` : '';
    }

    function buildCard(it, index) {
      const errs = {};
      const inputs = {};
      const slots = {};
      const visibility = {};
      const ui = {
        input: (value, attrs = {}) => h('input', { type: 'text', value, autocomplete: 'off', ...attrs }),
        textarea: (value, attrs = {}) => h('textarea', { value, ...attrs }),
        select: (value, choices) => {
          const el = h('select');
          for (const [v, label] of Object.entries(choices)) {
            const option = document.createElement('option');
            option.value = v;
            option.textContent = label;
            el.append(option);
          }
          el.value = value;
          return el;
        },
        field(key, label, control, hint = '', counter = null, extra = {}) {
          control.dataset.je = key;
          inputs[key] = control;
          const err = h('span', { class: 'je-err', role: 'alert', hidden: true });
          errs[key] = err;
          const wrap = h(
            'label',
            { class: 'je-field' },
            h('span', { class: 'je-label', text: label }),
            control,
            hint ? h('small', { class: 'je-hint', text: hint }) : null,
            err,
          );
          if (counter) {
            const count = h('small', { class: 'je-hint', text: counter(control.value) });
            control.addEventListener('input', () => {
              count.textContent = counter(control.value);
            });
            wrap.append(count);
          }
          if (extra.slot) {
            slots[extra.slot] = wrap;
            visibility[extra.slot] = extra.showWhen;
          }
          return wrap;
        },
        check(key, label, checked) {
          const box = h('input', { type: 'checkbox', checked: Boolean(checked) });
          box.dataset.je = key;
          inputs[key] = box;
          return h('label', { class: 'je-check' }, box, h('span', { text: label }));
        },
        grid: (...kids) => h('div', { class: 'je-grid' }, ...kids),
        note: (message) => h('p', { class: 'je-hint', text: message }),
        details: (summary, ...kids) => h('details', { class: 'je-adv' }, h('summary', { text: summary }), ...kids),
      };
      const head = h(
        'div',
        { class: 'je-item-head' },
        h('strong', { text: `${kind.itemName} ${index + 1}` }),
        h('span', { class: 'je-spacer' }),
        h('button', { type: 'button', class: 'dx-btn dx-btn-sm', 'data-je-act': 'up', text: 'Move up', disabled: index === 0 }),
        h('button', {
          type: 'button',
          class: 'dx-btn dx-btn-sm',
          'data-je-act': 'down',
          text: 'Move down',
          disabled: index === items.length - 1,
        }),
        h('button', { type: 'button', class: 'dx-btn dx-btn-sm dx-btn-ghost-danger', 'data-je-act': 'remove', text: 'Remove' }),
      );
      const card = h('div', { class: 'je-item' }, head, h('div', { class: 'je-item-body' }, ...kind.fields(it, ui)));
      card._je = { item: it, errs, inputs, slots, visibility };
      return card;
    }

    function render(focusSelector) {
      list.replaceChildren();
      items.forEach((it, i) => list.append(buildCard(it, i)));
      if (!items.length)
        list.append(
          h('p', { class: 'je-empty', text: `Nothing here yet. Use "${kind.addLabel}" to start.` }),
        );
      refresh();
      if (focusSelector) list.querySelector(focusSelector)?.focus();
    }

    list.addEventListener('input', (event) => {
      const target = event.target;
      const key = target.dataset?.je;
      const card = target.closest('.je-item');
      if (!key || !card) return;
      const it = card._je.item;
      it[key] = target.type === 'checkbox' ? target.checked : target.value;
      if (key === 'name') it.nameEdited = true;
      commit();
      refresh();
    });
    list.addEventListener('change', (event) => {
      if (event.target.dataset?.je === 'type') refresh();
    });
    list.addEventListener('focusout', (event) => {
      const key = event.target.dataset?.je;
      const card = event.target.closest?.('.je-item');
      if (!key || !card) return;
      (card._je.item._touched ||= new Set()).add(key);
      refresh();
    });
    list.addEventListener('click', (event) => {
      const button = event.target.closest('[data-je-act]');
      if (!button || button.disabled) return;
      const card = button.closest('.je-item');
      const i = items.indexOf(card._je.item);
      const act = button.dataset.jeAct;
      if (act === 'remove') {
        items.splice(i, 1);
        render();
        commit();
        return;
      }
      const j = act === 'up' ? i - 1 : i + 1;
      if (j < 0 || j >= items.length) return;
      [items[i], items[j]] = [items[j], items[i]];
      render(`.je-item:nth-child(${j + 1}) [data-je-act="${act}"]`);
      commit();
    });
    add.addEventListener('click', () => {
      if (items.length >= kind.limit) return;
      items.push(kind.blank());
      render(`.je-item:nth-child(${items.length}) input, .je-item:nth-child(${items.length}) textarea`);
    });

    // Other scripts set the textarea value directly (for example when editing a saved form).
    Object.defineProperty(textarea, 'value', {
      configurable: true,
      get() {
        return valueProp.get.call(this);
      },
      set(value) {
        valueProp.set.call(this, value);
        read(value);
        render();
      },
    });
    textarea.form?.addEventListener('reset', () =>
      setTimeout(() => {
        read(valueProp.get.call(textarea));
        render();
      }, 0),
    );

    read(valueProp.get.call(textarea));
    render();
    // Keep the stored JSON tidy and in sync with what the editor shows.
    valueProp.set.call(textarea, JSON.stringify(serialize()));

    editors.push({
      form: textarea.form,
      root,
      validate() {
        showAll = true;
        refresh();
        const filled = items.filter((it) => !kind.isEmpty(it));
        for (let i = 0; i < items.length; i++) {
          if (kind.isEmpty(items[i])) continue;
          const found = kind.problems(items[i], filled);
          const first = Object.values(found)[0];
          if (first) return `${spec.heading}: ${kind.itemName.toLowerCase()} ${i + 1}. ${first}`;
        }
        if (filled.length < kind.min) return `${spec.heading}: add at least one ${kind.itemName.toLowerCase()}.`;
        return '';
      },
    });
  }

  // Stop a save that has incomplete or invalid rows, before the page's own handlers run.
  document.addEventListener(
    'submit',
    (event) => {
      const mine = editors.filter((ed) => ed.form === event.target);
      for (const ed of mine) {
        const message = ed.validate();
        if (!message) continue;
        event.preventDefault();
        event.stopImmediatePropagation();
        ed.root.scrollIntoView({ block: 'center', behavior: 'smooth' });
        const notice = document.querySelector('#settings-notice, #form-notice');
        if (notice) notice.textContent = `Could not save. ${message}`;
        return;
      }
    },
    true,
  );

  const start = () => {
    for (const [name, spec] of Object.entries(BY_NAME)) {
      for (const textarea of document.querySelectorAll(`textarea[name="${name}"]`)) mount(textarea, spec);
    }
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
