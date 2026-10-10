const list = document.querySelector('#cms-list');
const form = document.querySelector('#cms-form');
const notice = document.querySelector('#cms-notice');
const reviewActions = document.querySelector('#cms-review-actions');
const mediaPanel = document.querySelector('#cms-media-panel');
const mediaList = document.querySelector('#cms-media-list');
const mediaForm = document.querySelector('#cms-media-form');
let selected = null;
const val = (name) => form.elements.namedItem(name)?.value ?? '';
const set = (name, value) => {
  const el = form.elements.namedItem(name);
  if (el) el.value = value ?? '';
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
async function loadItem(id) {
  try {
    const item = await api(`/dashboard/opportunities/${encodeURIComponent(id)}`);
    selected = item;
    const fields = {
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
      classification: 'classification',
      labels_json: 'labels',
    };
    for (const [key, name] of Object.entries(fields))
      set(name, key === 'labels_json' ? parseLabels(item[key]).join(', ') : item[key]);
    set('id', item.id);
    document.querySelector('#cms-form-title').textContent = `Edit: ${item.title}`;
    reviewActions.hidden = false;
    mediaPanel.hidden = false;
    document.querySelector('#cms-reason').value = '';
    await loadMedia(item.id);
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
  mediaList.replaceChildren();
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
      'classification',
      'priceText',
      'summary',
      'availability',
      'seoTitle',
      'seoDescription',
      'bodyHtml',
    ].map((name) => [name, val(name)]),
  );
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
