const list = document.querySelector('#cms-list');
const form = document.querySelector('#cms-form');
const notice = document.querySelector('#cms-notice');
const reviewActions = document.querySelector('#cms-review-actions');
let selected = null;
const val = (name) => form.elements.namedItem(name).value;
const set = (name, value) => {
  form.elements.namedItem(name).value = value ?? '';
};
const say = (message) => {
  notice.textContent = message;
};
async function loadBrokers() {
  try {
    const brokers = await api('/dashboard/brokers');
    const select = form.elements.namedItem('assignedBrokerId');
    for (const broker of brokers) {
      const option = document.createElement('option');
      option.value = broker.id;
      option.textContent = `${broker.displayName || broker.email} · ${broker.email}`;
      select.append(option);
    }
  } catch (error) {
    say(`Could not load broker assignments: ${error.message}`);
  }
}
async function api(url, options = {}) {
  const response = await fetch(url, {
    credentials: 'same-origin',
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body?.error?.message || `Request failed (${response.status})`);
  return body.data;
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
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = `${item.title} · ${item.reviewStatus} · ${item.lifecycle}`;
      button.addEventListener('click', () => loadItem(item.id));
      li.append(button);
      list.append(li);
    }
    if (!data.length) list.textContent = 'No matching opportunities.';
  } catch (error) {
    list.textContent = error.message;
  }
}
async function loadItem(id) {
  try {
    const item = await api(`/dashboard/opportunities/${encodeURIComponent(id)}`);
    selected = item;
    for (const [key, name] of Object.entries({
      title: 'title',
      country: 'country',
      opportunity_type: 'opportunityType',
      price_text: 'priceText',
      summary: 'summary',
      availability: 'availability',
      seo_title: 'seoTitle',
      seo_description: 'seoDescription',
      body_html: 'bodyHtml',
      assigned_broker_id: 'assignedBrokerId',
    }))
      set(name, item[key]);
    set('id', item.id);
    document.querySelector('#cms-form-title').textContent = `Edit: ${item.title}`;
    reviewActions.hidden = false;
    document.querySelector('#cms-reason').value = '';
    say(`Loaded ${item.title}. Changes save as a private draft and reset review.`);
  } catch (error) {
    say(error.message);
  }
}
function newItem() {
  selected = null;
  form.reset();
  set('id', '');
  reviewActions.hidden = true;
  document.querySelector('#cms-form-title').textContent = 'Create opportunity';
  say('New opportunity starts private and pending review.');
}
form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const data = Object.fromEntries(
    [
      'title',
      'country',
      'opportunityType',
      'priceText',
      'summary',
      'availability',
      'seoTitle',
      'seoDescription',
      'bodyHtml',
    ].map((name) => [name, val(name)]),
  );
  data.assignedBrokerId = val('assignedBrokerId') || null;
  try {
    if (selected)
      await api(`/dashboard/opportunities/${encodeURIComponent(selected.id)}`, {
        method: 'PATCH',
        body: JSON.stringify(data),
      });
    else {
      const created = await api('/dashboard/opportunities', {
        method: 'POST',
        body: JSON.stringify(data),
      });
      await loadItem(created.id);
    }
    say('Saved. The listing is private and requires a fresh review.');
    await loadBrokers().then(() => {
      loadList();
      const selectedId = new URLSearchParams(window.location.search).get('selected');
      if (selectedId) loadItem(selectedId);
    });
  } catch (error) {
    say(error.message);
  }
});
document.querySelector('#cms-new').addEventListener('click', newItem);
document.querySelector('#cms-refresh').addEventListener('click', loadList);
document.querySelector('#cms-search').addEventListener('change', loadList);
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
document.querySelector('#cms-reject').addEventListener('click', () => review('rejected'));
document.querySelector('#cms-publish-button').addEventListener('click', async () => {
  if (!selected) return say('Select an opportunity first.');
  if (!document.querySelector('#cms-publish').checked)
    return say('Confirm the public-visibility checkbox before publishing.');
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
    say('Published. Recheck public detail, search, sitemap and API routes in staging.');
  } catch (error) {
    say(error.message);
  }
});
loadBrokers().then(() => {
  loadList();
  const selectedId = new URLSearchParams(window.location.search).get('selected');
  if (selectedId) loadItem(selectedId);
});
