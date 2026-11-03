/* Site content: builds a form from a field definition and reads it back. Presentation only; the server validates everything. */
(() => {
  'use strict';
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

  function control(field, value) {
    const name = esc(field.name);
    const max = field.max ? ` maxlength="${field.max}"` : '';
    const req = field.required ? ' required' : '';
    const ph = field.placeholder ? ` placeholder="${esc(field.placeholder)}"` : '';
    switch (field.type) {
      case 'textarea':
        return `<textarea name="${name}" rows="${field.max > 1000 ? 8 : 4}"${max}${req}${ph}>${esc(value)}</textarea>`;
      case 'select':
        return `<select name="${name}">${(field.options || [])
          .map(([key, label]) => `<option value="${esc(key)}"${String(value ?? '') === key ? ' selected' : ''}>${esc(label)}</option>`)
          .join('')}</select>`;
      case 'toggle':
        return `<span class="sc-check"><input type="checkbox" name="${name}"${value === true ? ' checked' : ''}> <span>${esc(field.label)}</span></span>`;
      case 'number':
        return `<input type="number" name="${name}" value="${esc(value)}"${field.min !== undefined ? ` min="${field.min}"` : ''}${field.max ? ` max="${field.max}"` : ''}${req}>`;
      case 'color': {
        const ok = /^#[0-9a-fA-F]{6}$/.test(value || '');
        return `<span class="sc-color"><input type="color" data-color-for="${name}" value="${ok ? esc(value) : '#000000'}" aria-label="Pick ${esc(field.label)}"><input type="text" name="${name}" value="${esc(value)}" maxlength="7" placeholder="#rrggbb (empty = built-in)" pattern="#[0-9a-fA-F]{6}"></span>`;
      }
      default:
        return `<input type="text" name="${name}" value="${esc(value)}"${max}${req}${ph}>`;
    }
  }

  function fieldHtml(field, value) {
    const wide = field.wide || field.type === 'textarea' ? ' data-wide' : '';
    const help = field.help ? `<small>${esc(field.help)}</small>` : '';
    const customOnly = /\(custom/i.test(field.label) ? ' data-custom-only' : '';
    if (field.type === 'toggle') return `<label class="sc-field sc-field-toggle"${wide}>${control(field, value)}${help}</label>`;
    return `<label class="sc-field"${wide}${customOnly}><span>${esc(field.label)}</span>${control(field, value)}${help}</label>`;
  }

  /** Form fields as HTML. `data` holds the current values. */
  function render(fields, data) {
    return `<div class="sc-grid">${fields.map((f) => fieldHtml(f, data[f.name])).join('')}</div>`;
  }

  /** Values of every field in the form. */
  function read(form, fields) {
    const out = {};
    for (const f of fields) {
      const el = form.elements[f.name];
      if (!el) continue;
      out[f.name] = f.type === 'toggle' ? el.checked : f.type === 'number' ? (el.value === '' ? '' : Number(el.value)) : el.value;
    }
    return out;
  }

  /** Keeps the colour pickers in step with their text boxes and shows custom-only fields only for custom sections. */
  function wire(form) {
    form.querySelectorAll('[data-color-for]').forEach((picker) => {
      const text = form.elements[picker.dataset.colorFor];
      picker.addEventListener('input', () => { text.value = picker.value; });
      text.addEventListener('input', () => { if (/^#[0-9a-fA-F]{6}$/.test(text.value)) picker.value = text.value; });
    });
    const type = form.elements.type;
    if (type && form.querySelector('[data-custom-only]')) {
      const sync = () => form.querySelectorAll('[data-custom-only]').forEach((el) => { el.hidden = type.value !== 'custom'; });
      type.addEventListener('change', sync);
      sync();
    }
  }

  window.SCFields = { esc, render, read, wire };
})();
