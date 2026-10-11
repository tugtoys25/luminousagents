const list = document.querySelector('#cms-list');
const form = document.querySelector('#cms-form');
const notice = document.querySelector('#cms-notice');
const reviewActions = document.querySelector('#cms-review-actions');
const mediaPanel = document.querySelector('#cms-media-panel');
const mediaList = document.querySelector('#cms-media-list');
const mediaForm = document.querySelector('#cms-media-form');
const historyPanel = document.querySelector('#cms-history-panel');
const historyList = document.querySelector('#cms-history-list');
const selectedBulkIds = new Set();
let selected = null;
const val = (name) => form.elements.namedItem(name)?.value ?? '';
const set = (name, value) => {
  const el = form.elements.namedItem(name);
  if (el) { if (el.type === 'checkbox') el.checked = value === true || value === 1 || value === '1'; else el.value = value ?? ''; }
};
const say = (message) => {
  notice.textContent = message;
};
const parseLabels = (value) => {
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value || '[]') : value;
    return Array.isArray(parsed) ? parsed.filter((x) => typeof x === 'string') : [];
  } catch {
    return [];
  }
};
const badgeTone = (value) => {
  const v = String(value || '').toLowerCase();
  if (v === 'approved' || v === 'published') return 'ok';
  if (v === 'pending' || v === 'draft' || v === 'under_offer' || v === 'on_hold') return 'warn';
  if (v === 'rejected' || v === 'sold' || v === 'archived') return 'danger';
  return '';
};
const badge = (value) => {
  const span = document.createElement('span');
  const tone = badgeTone(value);
  span.className = `ws-badge${tone ? ` ws-badge--${tone}` : ''}`;
  span.textContent = String(value || '—').replace(/_/g, ' ');
  return span;
};
const showBadges = (item) => {
  const host = document.querySelector('#cms-flow-badges');
  if (!host) return;
  host.replaceChildren();
  if (item)
    host.append(
      badge(item.content_review_status || item.reviewStatus),
      badge(item.lifecycle),
      badge(item.classification),
    );
};
const markSelected = () => {
  for (const b of list.querySelectorAll('button[data-id]'))
    b.toggleAttribute('aria-current', Boolean(selected && b.dataset.id === selected.id));
};
async function api(url, options = {}) {
  const response = await fetch(url, {
    credentials: 'same-origin',
    ...options,
    headers: {
      ...(options.body instanceof FormData ? {} : { 'Content-Type': 'application/json' }),
      ...(options.headers || {}),
    },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body?.error?.message || `Request failed (${response.status})`);
  return body.data;
}
async function loadBrokers() {
  try {
    const brokers = await api('/dashboard/brokers');
    const select = form.elements.namedItem('assignedBrokerId');
    const current = select.value;
    const unassigned = document.createElement('option');
    unassigned.value = '';
    unassigned.textContent = 'Unassigned';
    select.replaceChildren(unassigned);
    for (const broker of brokers) {
      const option = document.createElement('option');
      option.value = broker.id;
      option.textContent = `${broker.displayName || broker.email} · ${broker.email}`;
      select.add(option);
    }
    select.value = current;
  } catch (error) {
    say(`Could not load broker assignments: ${error.message}`);
  }
}
async function loadList() {
  list.textContent = 'Loading…';
  try {
    const params = new URLSearchParams({
      q: document.querySelector('#cms-search').value,
      review: document.querySelector('#cms-review').value,
    });
    const data = await api(`/dashboard/opportunities?${params}`);
    list.replaceChildren();
    for (const item of data) {
      const li = document.createElement('li');
      const select = document.createElement('input');
      select.type = 'checkbox';
      select.className = 'cms-row-select';
      select.setAttribute('aria-label', `Select ${item.title}`);
      select.checked = selectedBulkIds.has(item.id);
      select.addEventListener('change', () => {
        if (select.checked) selectedBulkIds.add(item.id);
        else selectedBulkIds.delete(item.id);
      });
      const button = document.createElement('button');
      button.type = 'button';
      button.dataset.id = item.id;
      if (selected && selected.id === item.id) button.setAttribute('aria-current', 'true');
      const title = document.createElement('span');
      title.className = 'row-title';
      title.textContent = item.title;
      const meta = document.createElement('span');
      meta.className = 'row-meta';
      meta.append(
        badge(item.reviewStatus),
        badge(item.lifecycle),
        ...(item.country ? [document.createTextNode(item.country)] : []),
      );
      button.append(title, meta);
      button.addEventListener('click', () => loadItem(item.id));
      li.append(select, button);
      list.append(li);
    }
    if (!data.length) list.textContent = 'No matching opportunities.';
  } catch (error) {
    list.textContent = error.message;
  }
}
async function loadMedia(opportunityId) {
  mediaList.textContent = 'Loading images…';
  try {
    const media = await api(`/dashboard/opportunities/${encodeURIComponent(opportunityId)}/media`);
    mediaList.replaceChildren();
    for (const item of media) {
      const li = document.createElement('li');
      li.append(
        document.createTextNode(`${item.altText} · ${Math.ceil(item.byteSize / 1024)} KB `),
      );
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.textContent = 'Remove';
      remove.addEventListener('click', async () => {
        try {
          await api(
            `/dashboard/opportunities/${encodeURIComponent(opportunityId)}/media/${encodeURIComponent(item.id)}`,
            { method: 'DELETE' },
          );
          await loadMedia(opportunityId);
          say('Image removed.');
        } catch (error) {
          say(error.message);
        }
      });
      li.append(remove);
      mediaList.append(li);
    }
    if (!media.length) mediaList.textContent = 'No listing images yet.';
  } catch (error) {
    mediaList.textContent = error.message;
  }
}
async function loadHistory(opportunityId) {
  if (!historyPanel || !historyList) return;
  historyPanel.hidden = false;
  historyList.textContent = 'Loading version history…';
  try {
    const versions = await api(`/dashboard/opportunities/${encodeURIComponent(opportunityId)}/versions`);
    historyList.replaceChildren();
    for (const version of versions) {
      const li = document.createElement('li');
      const description = document.createElement('span');
      description.textContent = `Version ${version.versionNumber} · ${version.createdAt} · ${version.changeReason || 'No reason recorded'}`;
      li.append(description);
      const restore = document.createElement('button');
      restore.type = 'button';
      restore.textContent = 'Restore as draft';
      restore.addEventListener('click', async () => {
        const reason = window.prompt(`Restore version ${version.versionNumber}? This returns the record to a private draft and requires fresh review. Enter a reason:`);
        if (!reason || reason.trim().length < 3) return say('Restore cancelled; provide a reason of at least 3 characters.');
        try {
          await api(`/dashboard/opportunities/${encodeURIComponent(opportunityId)}/versions/${encodeURIComponent(version.versionNumber)}/restore`, { method: 'POST', body: JSON.stringify({ reason: reason.trim() }) });
          await loadItem(opportunityId);
          await loadList();
          say(`Version ${version.versionNumber} restored as a private draft.`);
        } catch (error) { say(error.message); }
      });
      li.append(restore);
      historyList.append(li);
    }
    if (!versions.length) historyList.textContent = 'No saved versions found.';
  } catch (error) { historyList.textContent = error.message; }
}
async function bulkReview(decision) {
  const ids = [...selectedBulkIds];
  if (!ids.length) return say('Select at least one opportunity first.');
  if (ids.length > 50) return say('Bulk review is limited to 50 opportunities at a time.');
  const reason = window.prompt(`Reason for ${decision} ${ids.length} selected opportunities:`);
  if (!reason || reason.trim().length < 3) return say('Bulk review cancelled; provide a reason of at least 3 characters.');
  try {
    const result = await api('/dashboard/opportunities/bulk-review', { method: 'POST', body: JSON.stringify({ ids, decision, reason: reason.trim() }) });
    selectedBulkIds.clear();
    document.querySelector('#cms-select-all').checked = false;
    await loadList();
    say(`Bulk review complete: ${result.processed} processed; ${result.outcomes.filter((item) => item.status === 'not_found').length} not found. All remain private.`);
  } catch (error) { say(error.message); }
}
document.querySelector('#cms-import-button')?.addEventListener('click', async () => {
  const input = document.querySelector('#cms-import-file');
  const file = input?.files?.[0];
  if (!file) return say('Choose a CSV file to import.');
  if (file.size > 1_000_000) return say('CSV import is limited to 1 MB.');
  if (!window.confirm('Import updates to existing opportunity IDs? Every imported record will become a private draft and require fresh review.')) return;
  try {
    const csv = await file.text();
    const response = await fetch('/dashboard/opportunities/import.csv', {
      method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'text/csv; charset=utf-8' }, body: csv,
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body?.error?.message || `Import failed (${response.status})`);
    selectedBulkIds.clear();
    await loadList();
    if (selected) await loadItem(selected.id);
    input.value = '';
    say(`Imported ${body.data.imported} opportunity updates. All imported records are private drafts requiring fresh review.`);
  } catch (error) { say(error.message); }
});
document.querySelector('#cms-bulk-approve')?.addEventListener('click', () => bulkReview('approved'));
document.querySelector('#cms-bulk-reject')?.addEventListener('click', () => bulkReview('rejected'));
document.querySelector('#cms-select-all')?.addEventListener('change', (event) => {
  const checked = event.currentTarget.checked;
  for (const checkbox of list.querySelectorAll('.cms-row-select')) {
    checkbox.checked = checked;
    const id = checkbox.closest('li')?.querySelector('button[data-id]')?.dataset.id;
    if (id) { if (checked) selectedBulkIds.add(id); else selectedBulkIds.delete(id); }
  }
});

async function loadItem(id) {
  try {
    const item = await api(`/dashboard/opportunities/${encodeURIComponent(id)}`);
    selected = item;
    const fields = {
      title: 'title',
      country: 'country',
      opportunity_type: 'opportunityType',
      price_text: 'priceText',
      price_visibility: 'priceVisibility',
      summary: 'summary',
      availability: 'availability',
      seo_title: 'seoTitle',
      seo_description: 'seoDescription',
      body_html: 'bodyHtml',
      assigned_broker_id: 'assignedBrokerId',
      classification: 'classification',
      labels_json: 'labels',
    };
    for (const [key, name] of Object.entries(fields))
      set(name, key === 'labels_json' ? parseLabels(item[key]).join(', ') : item[key]);
    set('id', item.id);
    document.querySelector('#cms-form-title').textContent = `Edit: ${item.title}`;
    showBadges(item);
    markSelected();
    form.dataset.serpPath = `/opportunities/${item.slug || 'your-listing'}`;
    reviewActions.hidden = false;
    mediaPanel.hidden = false;
    document.querySelector('#cms-reason').value = '';
    await loadMedia(item.id);
    await loadHistory(item.id);
    say(`Loaded ${item.title}. Saving changes resets content review and public visibility.`);
  } catch (error) {
    say(error.message);
  }
}
function newItem() {
  selected = null;
  form.reset();
  set('id', '');
  reviewActions.hidden = true;
  mediaPanel.hidden = true;
  if (historyPanel) historyPanel.hidden = true;
  mediaList.replaceChildren();
  document.querySelector('#cms-form-title').textContent = 'Create opportunity';
  showBadges(null);
  markSelected();
  form.dataset.serpPath = '/opportunities/your-listing';
  say('New opportunity starts private and pending review.');
}
form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const data = Object.fromEntries(
    [
      'title',
      'country',
      'opportunityType',
      'classification',
      'priceText',
      'summary',
      'availability',
      'seoTitle',
      'seoDescription',
      'bodyHtml',
    ].map((name) => [name, val(name)]),
  );
  data.priceVisibility = Boolean(form.elements.namedItem('priceVisibility')?.checked);
  data.assignedBrokerId = val('assignedBrokerId') || null;
  data.labels = val('labels')
    .split(',')
    .map((label) => label.trim())
    .filter(Boolean)
    .slice(0, 12);
  try {
    if (selected) {
      await api(`/dashboard/opportunities/${encodeURIComponent(selected.id)}`, {
        method: 'PATCH',
        body: JSON.stringify(data),
      });
      await loadItem(selected.id);
    } else {
      const created = await api('/dashboard/opportunities', {
        method: 'POST',
        body: JSON.stringify(data),
      });
      await loadItem(created.id);
    }
    await loadList();
    say('Saved as a private draft requiring fresh review.');
  } catch (error) {
    say(error.message);
  }
});
mediaForm?.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!selected) return say('Save the listing before uploading images.');
  const data = new FormData(mediaForm);
  try {
    await api(`/dashboard/opportunities/${encodeURIComponent(selected.id)}/media`, {
      method: 'POST',
      body: data,
    });
    mediaForm.reset();
    await loadMedia(selected.id);
    say(
      'Image uploaded. It remains private until the listing is approved, published and classified public.',
    );
  } catch (error) {
    say(error.message);
  }
});
document.querySelector('#cms-new').addEventListener('click', newItem);
document.querySelector('#cms-refresh').addEventListener('click', loadList);
document.querySelector('#cms-search').addEventListener('change', loadList);
let searchTimer;
document.querySelector('#cms-search').addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(loadList, 300);
});
document.querySelector('#cms-review').addEventListener('change', loadList);
async function review(decision) {
  if (!selected) return say('Select an opportunity first.');
  const reason = document.querySelector('#cms-reason').value.trim();
  if (reason.length < 3) return say('Enter a review reason of at least 3 characters.');
  try {
    await api(`/dashboard/opportunities/${encodeURIComponent(selected.id)}/review`, {
      method: 'POST',
      body: JSON.stringify({ decision, reason, verifiedAt: new Date().toISOString() }),
    });
    await loadItem(selected.id);
    await loadList();
    say(`Content ${decision}. It remains private until separately published.`);
  } catch (error) {
    say(error.message);
  }
}
document.querySelector('#cms-approve').addEventListener('click', () => review('approved'));
document.querySelector('#cms-verify')?.addEventListener('click', async () => {
  if (!selected) return say('Select an opportunity first.');
  const reason = document.querySelector('#cms-reason').value.trim();
  if (reason.length < 3) return say('Add a verification note of at least 3 characters before marking this record verified.');
  try {
    await api(`/dashboard/opportunities/${encodeURIComponent(selected.id)}/verify`, { method: 'POST', body: JSON.stringify({ reason }) });
    await loadItem(selected.id);
    await loadList();
    say('Verification date updated and audit event recorded. Publication status was not changed.');
  } catch (error) { say(error.message || 'Could not update verification date.'); }
});
document.querySelector('#cms-reject').addEventListener('click', () => review('rejected'));
document.querySelector('#cms-publish-button').addEventListener('click', async () => {
  if (!selected) return say('Select an opportunity first.');
  if (!document.querySelector('#cms-publish').checked)
    return say('Confirm the public-visibility checkbox before publishing.');
  if (val('classification') !== 'public')
    return say('Set classification to Public, save, and re-review before publication.');
  const reason = document.querySelector('#cms-reason').value.trim();
  if (reason.length < 3) return say('Enter a publication reason of at least 3 characters.');
  try {
    await api(`/dashboard/opportunities/${encodeURIComponent(selected.id)}/publication`, {
      method: 'POST',
      body: JSON.stringify({
        lifecycle: 'published',
        publicVisibility: true,
        changeReason: reason,
      }),
    });
    await loadItem(selected.id);
    await loadList();
    say('Published. Confirm public detail, directory, image delivery and sitemap in staging.');
  } catch (error) {
    say(error.message);
  }
});
loadBrokers().then(async () => {
  await loadList();
  const selectedId = new URLSearchParams(window.location.search).get('selected');
  if (selectedId) await loadItem(selectedId);
});
