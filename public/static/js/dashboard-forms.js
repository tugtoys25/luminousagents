(() => {
  const f = document.querySelector('#managed-form-form');
  if (!f) return;
  const list = document.querySelector('#managed-forms'),
    notice = document.querySelector('#form-notice'),
    submissions = document.querySelector('#managed-submissions');
  async function load() {
    try {
      const r = await fetch('/dashboard/forms');
      const j = await r.json();
      list.replaceChildren();
      for (const item of j.data || []) {
        const li = document.createElement('li'),
          a = document.createElement('a');
        a.href = '/forms/' + encodeURIComponent(item.slug);
        a.target = '_blank';
        a.textContent = `${item.title} (${item.status}) — /forms/${item.slug}`;
        const b = document.createElement('button');
        b.type = 'button';
        b.textContent = 'Edit';
        b.onclick = () => {
          f.elements.id.value = item.id;
          f.elements.title.value = item.title;
          f.elements.slug.value = item.slug;
          f.elements.description.value = item.description;
          f.elements.fieldsJson.value = JSON.stringify(JSON.parse(item.fieldsJson), null, 2);
          f.elements.status.value = item.status;
          f.elements.notificationEnabled.checked = !!item.notificationEnabled;
        };
        li.append(a, ' ', b);
        list.append(li);
      }
    } catch {
      list.textContent = 'Unable to load forms.';
    }
    await loadSubmissions();
  }
  const STATUSES = ['new', 'in_progress', 'closed', 'spam'];
  const label = (v) => String(v).replace(/_/g, ' ');
  const fStatus = document.querySelector('#sub-status'),
    fQuery = document.querySelector('#sub-q'),
    exportLink = document.querySelector('#sub-export');
  const role = document.querySelector('meta[name="mayfair-staff"]')?.getAttribute('content') || '';
  const canEdit = ['admin', 'super_admin', 'editor', 'broker'].includes(role);
  const filterQuery = () => {
    const p = new URLSearchParams();
    if (fStatus?.value) p.set('status', fStatus.value);
    if (fQuery?.value.trim()) p.set('q', fQuery.value.trim());
    return p.toString();
  };
  async function loadSubmissions() {
    if (exportLink) exportLink.href = '/dashboard/form-submissions/export.csv?' + filterQuery();
    try {
      const r = await fetch('/dashboard/form-submissions?' + filterQuery());
      const j = await r.json();
      if (!r.ok) throw new Error(j.error?.message || 'Unable to load submissions.');
      submissions.replaceChildren();
      for (const item of j.data || []) {
        const card = document.createElement('article');
        card.className = 'managed-submission';
        const h = document.createElement('h3');
        h.textContent =
          item.formTitle + (item.opportunityTitle ? ' — ' + item.opportunityTitle : '');
        const badge = document.createElement('span');
        badge.className = 'ws-badge ws-badge--' + item.status;
        badge.textContent = label(item.status);
        h.append(' ', badge);
        const time = document.createElement('p');
        time.className = 'muted';
        time.textContent = new Date(item.createdAt).toLocaleString() + ' · ' + item.id;
        const dl = document.createElement('dl');
        for (const [k, v] of Object.entries(item.data || {})) {
          const dt = document.createElement('dt'),
            dd = document.createElement('dd');
          dt.textContent = k.replace(/_/g, ' ');
          dd.textContent = String(v);
          dl.append(dt, dd);
        }
        const sel = document.createElement('select');
        for (const s of STATUSES) {
          const o = document.createElement('option');
          o.value = s;
          o.textContent = label(s);
          o.selected = s === item.status;
          sel.append(o);
        }
        const note = document.createElement('textarea');
        note.rows = 2;
        note.maxLength = 3000;
        note.placeholder = 'Internal note';
        note.value = item.internalNote || '';
        const save = document.createElement('button');
        save.type = 'button';
        save.textContent = 'Save';
        sel.disabled = note.disabled = save.disabled = !canEdit;
        save.onclick = async () => {
          save.disabled = true;
          try {
            const res = await fetch('/dashboard/form-submissions/' + encodeURIComponent(item.id), {
              method: 'PATCH',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ status: sel.value, internalNote: note.value }),
            });
            const body = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(body.error?.message || 'Could not save.');
            notice.textContent = 'Submission updated.';
            await loadSubmissions();
          } catch (err) {
            notice.textContent = err.message;
            save.disabled = false;
          }
        };
        const row = document.createElement('div');
        row.className = 'sub-actions';
        row.append(sel, note, save);
        card.append(h, time, dl, row);
        submissions.append(card);
      }
      if (!submissions.childElementCount) submissions.textContent = 'No submissions match.';
    } catch (err) {
      submissions.textContent = err.message || 'Unable to load submissions.';
    }
  }
  let filterTimer;
  fStatus?.addEventListener('change', loadSubmissions);
  fQuery?.addEventListener('input', () => {
    clearTimeout(filterTimer);
    filterTimer = setTimeout(loadSubmissions, 250);
  });
  f.addEventListener('submit', async (e) => {
    e.preventDefault();
    const d = Object.fromEntries(new FormData(f));
    d.notificationEnabled = f.elements.notificationEnabled.checked;
    notice.textContent = 'Saving…';
    try {
      const r = await fetch('/dashboard/forms', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(d),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error?.message || 'Could not save form');
      notice.textContent = `Saved. Public URL: ${j.data.url}`;
      f.elements.id.value = j.data.id;
      await load();
    } catch (err) {
      notice.textContent = err.message || 'Could not save form';
    }
  });
  load();
})();
