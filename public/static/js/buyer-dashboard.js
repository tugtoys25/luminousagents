(() => {
  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const signInWrap = $('#sign-in-wrap');
  const workspace = $('#buyer-content');
  const flash = $('#buyer-flash');
  const gateNotice = $('#account-notice');
  const VIEWS = {
    overview: 'Overview',
    nda: 'NDA & access',
    documents: 'Data room',
    saved: 'Saved opportunities',
    profile: 'Profile & criteria',
  };
  const PREVIEW_TYPES = [
    'application/pdf',
    'image/png',
    'image/jpeg',
    'image/gif',
    'image/webp',
    'text/plain',
  ];
  const THEMES = ['forest', 'ivory', 'midnight'];
  const THEME_KEY = 'mayfair.dashboard.theme';
  const params = new URLSearchParams(window.location.search);
  let requestedOpportunity = params.get('opportunity') || '';
  let activeNdaTemplateId = '';
  let lastFocus = null;
  const state = {
    ndas: [],
    groups: [],
    saved: [],
    activity: { ndaDownloadedAt: null, documents: {} },
  };

  const esc = (value) =>
    String(value ?? '').replace(
      /[&<>"']/g,
      (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
    );
  const store = {
    get(key) {
      try {
        return window.localStorage.getItem(key);
      } catch {
        return null;
      }
    },
    set(key, value) {
      try {
        window.localStorage.setItem(key, value);
      } catch {
        /* storage unavailable */
      }
    },
  };
  const say = (text, ok = false) => {
    flash.textContent = text || '';
    flash.classList.toggle('ok', Boolean(ok));
  };
  const fmtDate = (value) => {
    if (!value) return '';
    const d = new Date(value);
    return Number.isNaN(d.getTime())
      ? ''
      : d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
  };
  const fmtSize = (bytes) => {
    const n = Number(bytes) || 0;
    if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(2)} MB`;
    if (n >= 1024) return `${Math.round(n / 1024)} KB`;
    return `${n} B`;
  };
  const baseType = (value) =>
    String(value || '')
      .split(';')[0]
      .trim()
      .toLowerCase();
  const canPreview = (doc) => PREVIEW_TYPES.includes(baseType(doc.contentType));
  const typeLabel = (doc) => {
    const ext =
      String(doc.filename || '')
        .split('.')
        .pop() || '';
    const label =
      ext && ext.length <= 4 && ext !== doc.filename
        ? ext
        : baseType(doc.contentType).split('/').pop() || 'FILE';
    return label.slice(0, 4).toUpperCase();
  };

  async function api(url, options = {}) {
    const response = await fetch(url, {
      credentials: 'same-origin',
      ...options,
      headers: {
        ...(options.body && !(options.body instanceof FormData)
          ? { 'Content-Type': 'application/json' }
          : {}),
        ...(options.headers || {}),
      },
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      if (payload.error?.code === 'PASSWORD_CHANGE_REQUIRED')
        window.location.assign('/account/change-password');
      const error = new Error(payload.error?.message || 'Request failed.');
      error.status = response.status;
      throw error;
    }
    return payload.data;
  }

  /* ---------- Theme ---------- */
  function applyTheme(name) {
    const theme = THEMES.includes(name) ? name : 'forest';
    document.documentElement.dataset.theme = theme;
    $$('[data-theme-set]').forEach((b) =>
      b.setAttribute('aria-pressed', String(b.dataset.themeSet === theme)),
    );
  }
  applyTheme(store.get(THEME_KEY));
  $$('[data-theme-set]').forEach((b) =>
    b.addEventListener('click', () => {
      store.set(THEME_KEY, b.dataset.themeSet);
      applyTheme(b.dataset.themeSet);
    }),
  );

  /* ---------- Navigation ---------- */
  function showView(name) {
    const view = VIEWS[name] ? name : 'overview';
    $$('[data-view-panel]').forEach((p) => {
      p.hidden = p.dataset.viewPanel !== view;
    });
    $$('.buyer-link[data-view]').forEach((a) => {
      if (a.dataset.view === view) a.setAttribute('aria-current', 'page');
      else a.removeAttribute('aria-current');
    });
    $('#buyer-crumb-title').textContent = VIEWS[view];
    workspace.classList.remove('is-open');
    $('#buyer-menu-toggle').setAttribute('aria-expanded', 'false');
  }
  const currentView = () =>
    (window.location.hash || '').replace('#', '') || (requestedOpportunity ? 'nda' : 'overview');
  window.addEventListener('hashchange', () => showView(currentView()));
  $('#buyer-menu-toggle').addEventListener('click', () => {
    const open = workspace.classList.toggle('is-open');
    $('#buyer-menu-toggle').setAttribute('aria-expanded', String(open));
  });

  /* ---------- NDA completion ---------- */
  function ndaProgress(n) {
    const now = Date.now();
    const expired = n.accessExpiresAt && new Date(n.accessExpiresAt).getTime() <= now;
    const revoked = Boolean(n.accessRevokedAt) || n.status === 'revoked';
    const decided = n.status !== 'pending';
    const approved = n.status === 'approved';
    const active = approved && Boolean(n.grantId) && !revoked && !expired;
    const hasPdf = Boolean(n.hasSignedPdf);
    const steps = [
      {
        title: 'NDA acknowledged',
        note: n.acceptedAt || n.createdAt ? fmtDate(n.acceptedAt || n.createdAt) : 'Submitted',
        state: 'done',
      },
      {
        title: 'Signed copy',
        note: hasPdf ? 'Uploaded and scanned' : decided ? 'Not required' : 'Optional upload',
        state: hasPdf || decided ? 'done' : 'current',
      },
      {
        title: 'Team review',
        note: n.status === 'rejected' ? 'Declined' : decided ? 'Completed' : 'In progress',
        state: n.status === 'rejected' ? 'blocked' : decided ? 'done' : hasPdf ? 'current' : 'todo',
      },
      {
        title: 'Access granted',
        note: active
          ? `Live${n.accessExpiresAt ? ` until ${fmtDate(n.accessExpiresAt)}` : ''}`
          : revoked
            ? 'Revoked'
            : expired
              ? 'Expired'
              : approved
                ? 'Being set up'
                : 'Awaiting review',
        state: active
          ? 'done'
          : revoked || expired || n.status === 'rejected'
            ? 'blocked'
            : approved
              ? 'current'
              : 'todo',
      },
    ];
    const done = steps.filter((s) => s.state === 'done').length;
    return { steps, percent: done * 25, active, expired, revoked };
  }
  const statusBadge = (n, progress) => {
    if (progress.active) return '<span class="buyer-badge buyer-badge--ok">Access active</span>';
    if (n.status === 'rejected')
      return '<span class="buyer-badge buyer-badge--danger">Declined</span>';
    if (progress.revoked)
      return '<span class="buyer-badge buyer-badge--danger">Access revoked</span>';
    if (progress.expired)
      return '<span class="buyer-badge buyer-badge--warn">Access expired</span>';
    if (n.status === 'pending')
      return '<span class="buyer-badge buyer-badge--info">In review</span>';
    return `<span class="buyer-badge">${esc(n.status)}</span>`;
  };
  function meterHtml(percent) {
    return `<div class="nda-meter"><div class="nda-meter-bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${percent}" aria-label="NDA completion"><span class="nda-meter-fill" data-pct="${percent}"></span></div><span class="nda-meter-label">${percent}%</span></div>`;
  }
  function stepsHtml(steps) {
    return `<ol class="nda-steps">${steps
      .map(
        (s, i) =>
          `<li class="nda-step" data-n="${i + 1}" data-state="${esc(s.state)}"><strong>${esc(s.title)}</strong>${esc(s.note)}</li>`,
      )
      .join('')}</ol>`;
  }
  function renderNdaList() {
    const target = $('#nda-list');
    if (!state.ndas.length) {
      target.innerHTML =
        '<p class="buyer-empty">No NDA requests yet. Open an opportunity from the directory and choose to request confidential access.</p>';
      return;
    }
    target.innerHTML = state.ndas
      .map((n) => {
        const p = ndaProgress(n);
        const reason = n.reviewReason
          ? `<p class="muted nda-extra">${esc(n.reviewReason)}</p>`
          : '';
        const upload =
          n.status === 'pending' && !n.hasSignedPdf
            ? `<div class="nda-extra"><form data-signed-nda="${esc(n.id)}"><label>Upload signed NDA PDF (optional)<input type="file" name="file" accept="application/pdf" required></label><button type="submit" class="buyer-btn buyer-btn-sm">Upload signed PDF</button><p class="notice" role="status"></p></form></div>`
            : '';
        const docsLink = p.active
          ? `<div class="nda-extra"><a class="buyer-btn buyer-btn-primary buyer-btn-sm" href="#documents">Open data room</a></div>`
          : '';
        return `<article class="nda-item"><div class="nda-item-head"><h3>${esc(n.opportunityTitle)}</h3>${statusBadge(n, p)}</div>${meterHtml(p.percent)}${stepsHtml(p.steps)}${reason}${upload}${docsLink}</article>`;
      })
      .join('');
    $$('form[data-signed-nda]', target).forEach((form) =>
      form.addEventListener('submit', async (event) => {
        event.preventDefault();
        const status = $('[role="status"]', form);
        const button = $('button[type="submit"]', form);
        const file = form.elements.namedItem('file').files?.[0];
        if (!file) {
          status.textContent = 'Choose a PDF first.';
          return;
        }
        const body = new FormData();
        body.append('file', file);
        button.disabled = true;
        status.textContent = 'Uploading and scanning PDF…';
        try {
          await api(
            `/api/buyer/nda-requests/${encodeURIComponent(form.dataset.signedNda)}/signed-pdf`,
            { method: 'POST', body },
          );
          say('Signed NDA PDF uploaded and passed the security scan.', true);
          await loadAll();
        } catch (error) {
          status.textContent = error.message || 'Could not upload the signed PDF.';
          button.disabled = false;
        }
      }),
    );
  }
  function renderOverview() {
    const active = state.ndas.filter((n) => ndaProgress(n).active);
    const best = state.ndas.reduce((max, n) => Math.max(max, ndaProgress(n).percent), 0);
    const docCount = state.groups.reduce((sum, g) => sum + g.docs.length, 0);
    const pending = state.ndas.filter((n) => n.status === 'pending').length;
    $('#buyer-metrics').innerHTML = [
      {
        label: 'NDA completion',
        value: `${best}%`,
        small: state.ndas.length
          ? `${state.ndas.length} request${state.ndas.length === 1 ? '' : 's'}`
          : 'No requests yet',
        tone: best === 100 ? 'ok' : best ? 'warn' : '',
      },
      {
        label: 'Active data rooms',
        value: String(active.length),
        small: pending ? `${pending} awaiting review` : 'Access you can use now',
        tone: active.length ? 'ok' : '',
      },
      {
        label: 'Documents available',
        value: String(docCount),
        small: 'Scanned and within your tier',
        tone: '',
      },
      {
        label: 'Saved opportunities',
        value: String(state.saved.length),
        small: 'Bookmarked listings',
        tone: '',
      },
    ]
      .map(
        (m) =>
          `<div class="buyer-metric" data-tone="${esc(m.tone)}"><span>${esc(m.label)}</span><strong>${esc(m.value)}</strong><small>${esc(m.small)}</small></div>`,
      )
      .join('');
    $('#overview-progress').innerHTML = state.ndas.length
      ? state.ndas
          .map((n) => {
            const p = ndaProgress(n);
            return `<article class="nda-item"><div class="nda-item-head"><h3>${esc(n.opportunityTitle)}</h3>${statusBadge(n, p)}</div>${meterHtml(p.percent)}</article>`;
          })
          .join('') + '<p class="nda-extra"><a href="#nda">View full NDA details</a></p>'
      : '<p class="buyer-empty">You have not requested access yet. Download the NDA from the NDA &amp; access page to review it first.</p>';
    const recent = state.groups
      .flatMap((g) => g.docs.map((d) => ({ ...d, groupTitle: g.title })))
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
      .slice(0, 4);
    $('#overview-docs').innerHTML = recent.length
      ? `<ul class="doc-list">${recent.map(docRow).join('')}</ul>`
      : '<p class="buyer-empty">No documents are available yet.</p>';
  }

  /* ---------- Documents ---------- */
  function docActivityBadge(id) {
    const a = state.activity.documents[id];
    if (a?.downloadedAt)
      return `<span class="buyer-badge buyer-badge--ok" data-dl-badge="${esc(id)}">✓ Downloaded ${esc(fmtDate(a.downloadedAt))}</span>`;
    if (a?.previewedAt)
      return `<span class="buyer-badge" data-dl-badge="${esc(id)}">Previewed</span>`;
    return `<span class="buyer-badge buyer-badge--warn" data-dl-badge="${esc(id)}" hidden>Not downloaded</span>`;
  }
  function docRow(d) {
    const id = encodeURIComponent(d.id);
    const preview = canPreview(d)
      ? `<button type="button" class="buyer-btn buyer-btn-sm" data-preview="${esc(d.id)}" data-name="${esc(d.filename)}">Preview</button>`
      : '<span class="doc-nopreview">Preview not available</span>';
    return `<li class="doc-row"><span class="doc-icon" aria-hidden="true">${esc(typeLabel(d))}</span><div class="doc-info"><span class="doc-name" title="${esc(d.filename)}">${esc(d.filename)}</span><div class="doc-meta"><span>${esc(fmtSize(d.byteSize))}</span><span>Added ${esc(fmtDate(d.createdAt))}</span><span class="buyer-badge buyer-badge--info">Tier ${esc(d.tier)}</span>${docActivityBadge(d.id)}</div></div><div class="doc-actions">${preview}<a class="buyer-btn buyer-btn-primary buyer-btn-sm" href="/api/buyer/documents/${id}/download" download="${esc(d.filename)}">Download</a></div></li>`;
  }
  function renderDocuments() {
    const root = $('#docs-root');
    if (!state.groups.length) {
      root.innerHTML =
        '<p class="buyer-empty">No data room is open yet. Once your NDA is approved, authorised documents appear here to preview and download. <a href="#nda">Check NDA status</a></p>';
      return;
    }
    root.innerHTML = state.groups
      .map((g) => {
        const body = g.error
          ? `<p class="notice">${esc(g.error)}</p>`
          : g.docs.length
            ? `<ul class="doc-list">${g.docs.map(docRow).join('')}</ul>`
            : '<p class="buyer-empty">No documents are available for your access tier yet.</p>';
        const expiry = g.expiresAt
          ? `<span class="buyer-badge buyer-badge--ok">Access until ${esc(fmtDate(g.expiresAt))}</span>`
          : '';
        return `<section class="buyer-card doc-group"><div class="doc-group-head"><h2>${esc(g.title)}</h2>${expiry}</div>${body}</section>`;
      })
      .join('');
  }
  async function loadDocuments() {
    const active = state.ndas.filter((n) => ndaProgress(n).active);
    const seen = new Set();
    const unique = active.filter((n) =>
      seen.has(n.opportunityId) ? false : seen.add(n.opportunityId),
    );
    state.groups = await Promise.all(
      unique.map(async (n) => {
        try {
          const docs = await api(
            `/api/buyer/opportunities/${encodeURIComponent(n.opportunityId)}/documents`,
          );
          return {
            id: n.opportunityId,
            title: n.opportunityTitle,
            expiresAt: n.accessExpiresAt,
            docs,
            error: '',
          };
        } catch (error) {
          return {
            id: n.opportunityId,
            title: n.opportunityTitle,
            expiresAt: n.accessExpiresAt,
            docs: [],
            error: error.message || 'Could not load documents.',
          };
        }
      }),
    );
  }

  /* ---------- Preview modal ---------- */
  const modal = $('#preview-modal');
  function openPreview(id, name, trigger) {
    lastFocus = trigger || document.activeElement;
    $('#preview-title').textContent = name || 'Preview';
    const downloadLink = $('#preview-download');
    downloadLink.href = `/api/buyer/documents/${encodeURIComponent(id)}/download`;
    downloadLink.setAttribute('download', name || '');
    const frame = document.createElement('iframe');
    frame.title = `Preview of ${name || 'document'}`;
    frame.src = `/api/buyer/documents/${encodeURIComponent(id)}/preview`;
    frame.setAttribute('referrerpolicy', 'no-referrer');
    $('#preview-body').replaceChildren(frame);
    modal.hidden = false;
    document.body.classList.add('buyer-noscroll');
    $('#preview-close').focus();
  }
  function closePreview() {
    if (modal.hidden) return;
    modal.hidden = true;
    $('#preview-body').replaceChildren();
    document.body.classList.remove('buyer-noscroll');
    if (lastFocus && typeof lastFocus.focus === 'function') lastFocus.focus();
  }
  $('#preview-close').addEventListener('click', closePreview);
  modal.addEventListener('click', (event) => {
    if (event.target === modal) closePreview();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closePreview();
    if (event.key === 'Tab' && !modal.hidden) {
      const focusable = $$('a[href], button:not([disabled])', modal);
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
  });
  document.addEventListener('click', (event) => {
    const dl =
      event.target instanceof window.Element
        ? event.target.closest('a[href$="/download"][download]')
        : null;
    const dlMatch = dl && /documents\/([^/]+)\/download$/.exec(dl.getAttribute('href') || '');
    if (dlMatch) {
      const id = decodeURIComponent(dlMatch[1]);
      state.activity.documents[id] = {
        ...(state.activity.documents[id] || {}),
        downloadedAt: new Date().toISOString(),
      };
      $$(`[data-dl-badge="${CSS.escape(id)}"]`).forEach((el) => {
        el.className = 'buyer-badge buyer-badge--ok';
        el.hidden = false;
        el.textContent = '✓ Download started';
      });
    }
    const button =
      event.target instanceof window.Element ? event.target.closest('[data-preview]') : null;
    if (button) openPreview(button.dataset.preview, button.dataset.name, button);
  });

  /* ---------- NDA template download ---------- */
  function showNdaStatus() {
    const status = $('#nda-dl-status');
    if (!status) return;
    const at = state.activity.ndaDownloadedAt;
    status.textContent = at ? `✓ NDA downloaded on ${fmtDate(at)}` : 'Not downloaded yet.';
    status.dataset.state = at ? 'done' : 'todo';
  }
  async function downloadNda(event) {
    event.preventDefault();
    const link = event.currentTarget;
    if (link.getAttribute('aria-disabled') === 'true') return;
    link.setAttribute('aria-disabled', 'true');
    const bar = $('#nda-dl-progress');
    const status = $('#nda-dl-status');
    bar.hidden = false;
    bar.removeAttribute('value');
    status.dataset.state = 'busy';
    status.textContent = 'Downloading…';
    try {
      const response = await fetch('/api/buyer/nda-template/download', {
        credentials: 'same-origin',
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        throw new Error(payload.error?.message || 'The NDA could not be downloaded.');
      }
      const total = Number(response.headers.get('content-length')) || 0;
      const chunks = [];
      let received = 0;
      if (response.body) {
        const reader = response.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(value);
          received += value.length;
          if (total) {
            bar.value = Math.round((received / total) * 100);
            status.textContent = `Downloading… ${bar.value}%`;
          }
        }
      }
      const blob = new window.Blob(chunks, { type: 'text/plain' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download =
        (/filename="([^"]+)"/.exec(response.headers.get('content-disposition') || '') || [])[1] ||
        'Mayfair-NDA.txt';
      document.body.append(a);
      a.click();
      a.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      bar.value = 100;
      state.activity.ndaDownloadedAt = new Date().toISOString();
      showNdaStatus();
      say('NDA download complete.', true);
      renderOverview();
    } catch (error) {
      status.dataset.state = 'error';
      status.textContent = error.message || 'The NDA could not be downloaded.';
      say(error.message || 'The NDA could not be downloaded.');
    } finally {
      window.setTimeout(() => {
        bar.hidden = true;
      }, 1500);
      link.removeAttribute('aria-disabled');
    }
  }
  $$('#nda-template-download, #nda-template-download-main').forEach((a) =>
    a.addEventListener('click', downloadNda),
  );

  /* ---------- Saved + profile ---------- */
  function renderSaved() {
    $('#saved-list').innerHTML = state.saved.length
      ? state.saved
          .map(
            (o) =>
              `<div class="buyer-item"><h3><a href="/opportunities/${encodeURIComponent(o.slug)}">${esc(o.title)}</a></h3><p>${esc(o.country || 'Location on request')}</p></div>`,
          )
          .join('')
      : '<p class="buyer-empty">No saved opportunities yet. Save opportunities while browsing the public directory.</p>';
  }
  async function loadProfile() {
    const form = $('#buyer-profile-form');
    const status = $('#buyer-profile-notice');
    try {
      const profile = await api('/api/buyer/profile');
      for (const key of [
        'companyName',
        'roleTitle',
        'budgetMin',
        'budgetMax',
        'currency',
        'experienceNotes',
      ]) {
        form.elements.namedItem(key).value = profile[key] ?? '';
      }
      form.elements.namedItem('countries').value = (profile.countries || []).join(', ');
    } catch (error) {
      status.textContent = error.message || 'Could not load your profile.';
    }
  }
  $('#buyer-profile-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const status = $('#buyer-profile-notice');
    const data = new FormData(form);
    const numeric = (key) =>
      String(data.get(key) || '').trim() === '' ? null : Number(data.get(key));
    const payload = {
      companyName: String(data.get('companyName') || '').trim(),
      roleTitle: String(data.get('roleTitle') || '').trim(),
      countries: String(data.get('countries') || '')
        .split(',')
        .map((v) => v.trim())
        .filter(Boolean),
      budgetMin: numeric('budgetMin'),
      budgetMax: numeric('budgetMax'),
      currency: String(data.get('currency') || 'GBP'),
      experienceNotes: String(data.get('experienceNotes') || '').trim(),
    };
    status.classList.remove('ok');
    status.textContent = 'Saving…';
    try {
      const profile = await api('/api/buyer/profile', {
        method: 'PUT',
        body: JSON.stringify(payload),
      });
      form.elements.namedItem('countries').value = (profile.countries || []).join(', ');
      status.classList.add('ok');
      status.textContent = 'Profile saved.';
    } catch (error) {
      status.textContent = error.message || 'Could not save your profile.';
    }
  });

  /* ---------- NDA request (from an opportunity page) ---------- */
  async function setupNdaRequest() {
    const panel = $('#nda-request-panel');
    panel.hidden = !requestedOpportunity;
    if (!requestedOpportunity) return;
    try {
      const template = await api('/api/buyer/nda-template');
      activeNdaTemplateId = template.id;
      $('#nda-template-content').textContent = template.content;
      $('#nda-template-version').textContent =
        `Template version ${template.version} · SHA-256 ${template.contentHash}`;
      $('#nda-request-form').hidden = false;
    } catch (error) {
      $('#nda-template-content').textContent = error.message;
      $('#nda-request-form').hidden = true;
    }
    $('#nda-request-form').onsubmit = async (event) => {
      event.preventDefault();
      const acceptanceName = String(
        new FormData(event.currentTarget).get('acceptanceName') || '',
      ).trim();
      try {
        await api(
          `/api/buyer/opportunities/${encodeURIComponent(requestedOpportunity)}/nda-requests`,
          {
            method: 'POST',
            body: JSON.stringify({ acceptanceName, templateId: activeNdaTemplateId }),
          },
        );
        say('Your NDA request has been submitted for review.', true);
        requestedOpportunity = '';
        panel.hidden = true;
        await loadAll();
      } catch (error) {
        say(error.message);
      }
    };
  }

  /* ---------- Load ---------- */
  async function loadAll() {
    const [saved, ndas] = await Promise.all([
      api('/api/buyer/opportunities').catch(() => []),
      api('/api/buyer/nda-requests').catch(() => []),
    ]);
    state.saved = saved;
    state.ndas = ndas;
    state.activity = await api('/api/buyer/activity').catch(() => state.activity);
    await loadDocuments();
    renderNdaList();
    renderDocuments();
    renderSaved();
    renderOverview();
    showNdaStatus();
  }
  async function loadAccount() {
    let buyer;
    try {
      buyer = await api('/api/buyer/me');
    } catch {
      signInWrap.hidden = false;
      workspace.hidden = true;
      return;
    }
    signInWrap.hidden = true;
    workspace.hidden = false;
    const name = buyer.displayName || buyer.email;
    $('#buyer-identity').textContent = `Signed in as ${name}`;
    $('#buyer-name').textContent = name;
    $('#buyer-email').textContent = buyer.email;
    $('#buyer-avatar').textContent =
      name
        .split(/[\s@.]+/)
        .filter(Boolean)
        .slice(0, 2)
        .map((p) => p[0].toUpperCase())
        .join('') || 'M';
    $('#buyer-password-choice')?.remove();
    if (!buyer.hasPassword) {
      const choice = document.createElement('p');
      choice.id = 'buyer-password-choice';
      choice.className = 'muted';
      choice.textContent =
        'You signed in with an email code. You can set a password later or continue signing in with email codes.';
      $('#buyer-identity').after(choice);
    }
    showView(currentView());
    await Promise.all([loadProfile(), setupNdaRequest(), loadAll()]);
  }
  $('#sign-out').addEventListener('click', async () => {
    try {
      await api('/api/buyer/auth/logout', { method: 'POST', body: JSON.stringify({}) });
    } finally {
      closePreview();
      workspace.hidden = true;
      signInWrap.hidden = false;
      gateNotice.textContent = 'You have signed out.';
    }
  });
  loadAccount();
})();
