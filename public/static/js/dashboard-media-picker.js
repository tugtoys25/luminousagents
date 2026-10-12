/* Shared media picker: progressive enhancement for image and document URL fields on all staff forms. */
(() => {
  'use strict';
  const API = '/dashboard/media';
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const labelFor = (el) => {
    const label = el.closest('label');
    return `${el.name || ''} ${el.id || ''} ${label?.innerText || ''}`.toLowerCase();
  };
  const fieldKind = (el) => {
    // Fields that only describe an image (alt text) or are handled by their own screen opt out.
    if (el.hasAttribute('data-no-media-picker')) return null;
    // Native file inputs and other non-text inputs are never URL fields.
    if (el instanceof HTMLInputElement && !['url', 'text', 'search'].includes(el.type)) return null;
    const key = labelFor(el);
    const documentField = /(document|pdf|attachment|nda|download|policy|terms|privacy|brochure|catalogue|catalog|file[_-]?(url|uri|src|path|link)|\bfile\b)/i.test(key);
    if (documentField && /(url|uri|src|document|pdf|attachment|nda|download|policy|terms|privacy|brochure|catalogue|catalog|file[_-]?(url|uri|src|path|link)|\bfile\b)/i.test(key)) return 'document';
    if (!/(image|picture|photo|logo|favicon|og|featured|cover|background|avatar|thumbnail|media|hero)/i.test(key)) return null;
    if (el instanceof HTMLInputElement && !['url', 'text', 'search'].includes(el.type)) return null;
    return 'image';
  };
  let overlay = null;
  let active = null;
  let kind = 'image';
  let rows = [];
  let query = '';
  let loading = false;

  async function request(url, options) {
    const response = await fetch(url, { credentials: 'same-origin', ...options });
    const json = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(json.error?.message || 'Media request failed.');
    return json;
  }
  function close() { overlay?.remove(); overlay = null; active = null; }
  function renderGrid() {
    const grid = overlay?.querySelector('.ml-picker-grid');
    const notice = overlay?.querySelector('.ml-picker-notice');
    if (!grid) return;
    if (loading) { grid.innerHTML = '<p class="ml-picker-empty">Loading library…</p>'; return; }
    if (!rows.length) { grid.innerHTML = '<p class="ml-picker-empty">No public files found. Upload or publish an item in the Media library first.</p>'; return; }
    grid.innerHTML = rows.map((m) => {
      const isImage = String(m.contentType).startsWith('image/');
      const preview = isImage && m.url ? `<img src="${esc(m.url)}" alt="${esc(m.altText || '')}" loading="lazy">` : `<span class="ml-file-icon">${esc((m.contentType.split('/').pop() || 'FILE').toUpperCase().slice(0, 5))}</span>`;
      return `<button class="ml-picker-item" type="button" data-id="${esc(m.id)}">${preview}<strong>${esc(m.filename)}</strong><small>${esc(m.folder || 'general')} · ${Math.ceil((m.byteSize || 0) / 1024)} KB</small></button>`;
    }).join('');
    grid.querySelectorAll('[data-id]').forEach((button) => button.addEventListener('click', () => {
      const item = rows.find((r) => r.id === button.dataset.id);
      if (!item?.url) { if (notice) notice.textContent = 'This item does not have a public URL.'; return; }
      active.value = item.url;
      active.dispatchEvent(new Event('input', { bubbles: true }));
      active.dispatchEvent(new Event('change', { bubbles: true }));
      active.focus();
      updatePreview(active);
      close();
    }));
  }
  async function load() {
    loading = true; renderGrid();
    try {
      const params = new URLSearchParams({ type: kind, visibility: 'public', limit: '100' });
      if (query) params.set('q', query);
      const result = await request(`${API}?${params}`);
      rows = result.data || [];
    } catch (error) {
      rows = [];
      const notice = overlay?.querySelector('.ml-picker-notice');
      if (notice) notice.textContent = error.message;
    } finally { loading = false; renderGrid(); }
  }
  function open(input, mediaKind) {
    active = input; kind = mediaKind; query = ''; rows = [];
    overlay = document.createElement('div');
    overlay.className = 'ml-picker-overlay';
    overlay.innerHTML = `<section class="ml-picker-dialog" role="dialog" aria-modal="true" aria-labelledby="ml-picker-title"><header class="ml-picker-head"><div><p class="eyebrow">MEDIA LIBRARY</p><h2 id="ml-picker-title">Choose ${kind === 'image' ? 'an image' : 'a document'}</h2></div><button type="button" class="ml-picker-close" aria-label="Close media picker">Close ×</button></header><div class="ml-picker-controls"><input type="search" class="ml-picker-search" placeholder="Search public media" aria-label="Search public media"><label class="ml-upload">Upload<input class="ml-picker-upload" type="file" multiple accept="${kind === 'image' ? 'image/jpeg,image/png,image/webp,image/gif' : 'application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'}"></label><a href="/dashboard/media/ui" target="_blank" rel="noopener">Manage library ↗</a></div><p class="ml-picker-notice" role="status"></p><div class="ml-picker-grid"></div></section>`;
    document.body.appendChild(overlay);
    overlay.querySelector('.ml-picker-close').addEventListener('click', close);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
    const search = overlay.querySelector('.ml-picker-search');
    let debounce;
    search.addEventListener('input', () => { clearTimeout(debounce); debounce = setTimeout(() => { query = search.value.trim(); load(); }, 220); });
    overlay.querySelector('.ml-picker-upload').addEventListener('change', async (e) => {
      const files = [...e.target.files]; if (!files.length) return;
      const notice = overlay.querySelector('.ml-picker-notice'); notice.textContent = 'Uploading…';
      try {
        const data = new FormData(); files.forEach((file) => data.append('file', file));
        await request(`${API}/upload`, { method: 'POST', body: data });
        notice.textContent = kind === 'image' ? 'Upload complete. Select the new public image below.' : 'Upload complete. Documents stay private until an administrator reviews and publishes them in the Media library.';
        await load();
      } catch (error) { notice.textContent = error.message; }
      e.target.value = '';
    });
    document.addEventListener('keydown', escKey);
    load();
  }
  function escKey(e) { if (e.key === 'Escape' && overlay) { close(); document.removeEventListener('keydown', escKey); } }
  function updatePreview(input) {
    const tools = input.parentElement?.querySelector(':scope > .ml-field-tools');
    if (!tools) return;
    let preview = tools.querySelector('img');
    if (!input.value || !/^https:\/\/|^\/media\//i.test(input.value) || kindOfUrl(input.value) === 'document') { preview?.remove(); return; }
    if (!preview) { preview = document.createElement('img'); preview.className = 'ml-field-preview'; preview.alt = 'Selected media preview'; tools.appendChild(preview); }
    preview.src = input.value;
    preview.onerror = () => preview.remove();
  }
  function kindOfUrl(url) { return /\.(pdf|docx?|xlsx?)(?:[?#].*)?$/i.test(url) ? 'document' : 'image'; }
  function enhance(input) {
    if (input.dataset.mediaPickerEnhanced || !fieldKind(input)) return;
    input.dataset.mediaPickerEnhanced = 'true';
    const kind = fieldKind(input);
    const tools = document.createElement('span'); tools.className = 'ml-field-tools';
    const choose = document.createElement('button'); choose.type = 'button'; choose.textContent = kind === 'image' ? 'Choose from Media' : 'Choose file';
    choose.addEventListener('click', () => open(input, kind));
    const remove = document.createElement('button'); remove.type = 'button'; remove.textContent = 'Remove';
    remove.addEventListener('click', () => { input.value = ''; input.dispatchEvent(new Event('input', { bubbles: true })); input.dispatchEvent(new Event('change', { bubbles: true })); updatePreview(input); input.focus(); });
    tools.append(choose, remove);
    input.insertAdjacentElement('afterend', tools);
    input.addEventListener('input', () => updatePreview(input));
    if (kind === 'image') updatePreview(input);
  }
  function scan(root = document) {
    root.querySelectorAll('input:not([type="hidden"]),textarea').forEach(enhance);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => scan()); else scan();
  new MutationObserver((mutations) => mutations.forEach((m) => m.addedNodes.forEach((n) => { if (n.nodeType === 1) { if (n.matches?.('input,textarea')) enhance(n); scan(n); } }))).observe(document.documentElement, { childList: true, subtree: true });
})();
