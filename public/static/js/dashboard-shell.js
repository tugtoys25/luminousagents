/* Sprint 18 final: Mayfair staff workspace shell.
 * Progressive enhancement only: every page still works (with its own links) when this script does not run.
 * Adds: grouped role-aware menu, menu filter, command palette (Ctrl/Cmd+K or /), themes, collapsible sidebar,
 * page headers, form helpers (counters, unsaved state, Ctrl/Cmd+S, slug, search preview), list filters and toasts.
 * Authorization is always enforced on the server; nothing here grants access. */
(() => {
  'use strict';
  const LS = {
    get(k) {
      try {
        return localStorage.getItem(k);
      } catch {
        return null;
      }
    },
    set(k, v) {
      try {
        localStorage.setItem(k, v);
      } catch {
        /* storage unavailable */
      }
    },
  };
  const THEMES = ['forest', 'ivory', 'midnight'];
  const THEME_KEY = 'mayfair.dashboard.theme';
  const SIDEBAR_KEY = 'mayfair.dashboard.sidebar';

  const applyTheme = (name) => {
    const theme = THEMES.includes(name) ? name : 'forest';
    document.documentElement.dataset.theme = theme;
    document
      .querySelectorAll('[data-theme-set]')
      .forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.themeSet === theme)));
    return theme;
  };
  applyTheme(LS.get(THEME_KEY));

  const ICONS = {
    home: '<path d="M3 11l9-7 9 7"/><path d="M5 10v10h14V10"/>',
    building:
      '<path d="M4 21V5l8-2v18"/><path d="M12 9l8 2v10"/><path d="M8 9h1M8 13h1M8 17h1M16 15h1M16 18h1"/>',
    users:
      '<circle cx="9" cy="8" r="3.2"/><path d="M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6"/><path d="M16 5a3 3 0 010 6M18 14c2 .6 3.5 2.6 3.5 5"/>',
    mail: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 7l9 6 9-6"/>',
    shield: '<path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z"/><path d="M9 12l2 2 4-4"/>',
    key: '<circle cx="8" cy="15" r="4"/><path d="M11 12l9-9M16 7l3 3"/>',
    doc: '<path d="M7 3h7l5 5v13H7z"/><path d="M14 3v5h5M10 13h6M10 17h6"/>',
    check: '<rect x="4" y="4" width="16" height="16" rx="3"/><path d="M8 12l3 3 5-6"/>',
    bell: '<path d="M6 16V11a6 6 0 1112 0v5l2 2H4z"/><path d="M10 21h4"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    page: '<rect x="4" y="3" width="16" height="18" rx="2"/><path d="M8 8h8M8 12h8M8 16h5"/>',
    form: '<rect x="4" y="3" width="16" height="18" rx="2"/><path d="M8 8h8M8 12h8"/><rect x="8" y="15" width="5" height="3" rx="1"/>',
    cog: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M19 5l-2 2M7 17l-2 2"/>',
    lock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 018 0v3"/>',
    globe:
      '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c3 3.5 3 14.5 0 18M12 3c-3 3.5-3 14.5 0 18"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    link: '<path d="M10 14a4 4 0 005.7 0l3-3a4 4 0 00-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 00-5.7 0l-3 3a4 4 0 005.7 5.7l1-1"/>',
    palette:
      '<circle cx="12" cy="12" r="9"/><circle cx="8" cy="10" r="1"/><circle cx="12" cy="7" r="1"/><circle cx="16" cy="10" r="1"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="M20 20l-4-4"/>',
    menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
    sidebar: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16"/>',
  };
  const svg = (name) =>
    `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">${ICONS[name] || ICONS.doc}</svg>`;

  // Canonical menu. `match` lists path prefixes that mark the item as current.
  const GROUPS = [
    {
      name: 'Workspace',
      items: [
        { label: 'Overview', href: '/dashboard', icon: 'home', exact: true, kw: 'dashboard home' },
      ],
    },
    {
      name: 'Deal management',
      items: [
        {
          label: 'Opportunity CMS',
          href: '/dashboard/opportunities/ui',
          icon: 'building',
          match: ['/dashboard/opportunities'],
          kw: 'listings casinos hotels deals',
        },
        {
          label: 'Buyer access',
          href: '/dashboard/buyers/ui',
          icon: 'users',
          match: ['/dashboard/buyers'],
          kw: 'buyers registrations accounts',
        },
        {
          label: 'Enquiries',
          href: '/dashboard/enquiries/ui',
          icon: 'mail',
          match: ['/dashboard/enquiries'],
          kw: 'contact leads messages',
        },
        {
          label: 'Seller enquiries',
          href: '/dashboard/seller-enquiries/ui',
          icon: 'mail',
          match: ['/dashboard/seller-enquiries'],
          kw: 'sellers sell casino brokerage leads',
        },
        {
          label: 'Seller settings',
          href: '/dashboard/seller-settings/ui',
          icon: 'settings',
          match: ['/dashboard/seller-settings'],
          kw: 'seller policy reminders recipients separation retention',
        },
        {
          label: 'Seller privacy',
          href: '/dashboard/seller-privacy/ui',
          icon: 'shield',
          match: ['/dashboard/seller-privacy'],
          kw: 'retention anonymise privacy request legal hold',
        },
        {
          label: 'NDA requests',
          href: '/dashboard/nda-requests/ui',
          icon: 'shield',
          match: ['/dashboard/nda-requests'],
          kw: 'nda review approve',
        },
        {
          label: 'Access grants',
          href: '/dashboard/access-grants/ui',
          icon: 'key',
          match: ['/dashboard/access-grants'],
          kw: 'data room revoke',
        },
        {
          label: 'NDA templates',
          href: '/dashboard/nda-templates/ui',
          icon: 'doc',
          match: ['/dashboard/nda-templates'],
          kw: 'legal template versions',
        },
      ],
    },
    {
      name: 'Operations',
      items: [
        {
          label: 'Tasks',
          href: '/dashboard/tasks/ui',
          icon: 'check',
          match: ['/dashboard/tasks'],
          kw: 'follow up todo assign',
        },
        {
          label: 'Notifications',
          href: '/dashboard/notifications/ui',
          icon: 'bell',
          match: ['/dashboard/notifications'],
          kw: 'jobs email delivery',
        },
      ],
    },
    {
      name: 'Content & site',
      items: [
        {
          label: 'Media library',
          href: '/dashboard/media/ui',
          icon: 'doc',
          match: ['/dashboard/media'],
          kw: 'images photos files pdf uploads assets library',
        },
        {
          label: 'Pages',
          href: '/dashboard/pages/ui',
          icon: 'page',
          match: ['/dashboard/pages'],
          kw: 'managed content seo',
        },
        {
          label: 'Forms',
          href: '/dashboard/forms/ui',
          icon: 'form',
          match: ['/dashboard/forms'],
          kw: 'managed forms submissions',
        },
        {
          label: 'Platform settings',
          href: '/dashboard/settings/ui',
          icon: 'cog',
          match: ['/dashboard/settings'],
          kw: 'branding colours navigation ga4',
        },
      ],
    },
    {
      name: 'Governance',
      items: [
        {
          label: 'Audit log',
          href: '/dashboard/audit/ui',
          icon: 'clock',
          match: ['/dashboard/audit'],
          kw: 'history changes',
        },
        {
          label: 'Staff accounts',
          href: '/dashboard/staff/ui',
          icon: 'lock',
          match: ['/dashboard/staff'],
          role: 'super_admin',
          kw: 'team users roles',
        },
      ],
    },
  ];
  const ACCOUNT = [
    { label: 'Password', href: '/admin/change-password' },
    { label: 'Public site', href: '/' },
    { label: 'Sign out', href: '/admin/logout' },
  ];
  const ACTIONS = [
    {
      label: 'New opportunity',
      href: '/dashboard/opportunities/ui',
      icon: 'plus',
      kw: 'create listing add',
    },
    { label: 'New task', href: '/dashboard/tasks/ui', icon: 'plus', kw: 'create follow up add' },
    { label: 'New page', href: '/dashboard/pages/ui', icon: 'plus', kw: 'create content add' },
    { label: 'View public site', href: '/', icon: 'globe', kw: 'website open' },
  ];

  const esc = (s) =>
    String(s ?? '').replace(
      /[&<>"']/g,
      (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
    );
  const el = (tag, cls, html) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (html != null) n.innerHTML = html;
    return n;
  };
  const isCurrent = (item, path) =>
    item.exact
      ? path === item.href
      : (item.match || [item.href]).some((m) => path === m || path.startsWith(`${m}/`));

  let toastHost;
  const toast = (message, kind) => {
    if (!message) return;
    if (!toastHost) toastHost = document.body.appendChild(el('div', 'ws-toasts'));
    const t = el('div', `ws-toast${kind ? ` is-${kind}` : ''}`);
    t.textContent = message;
    toastHost.append(t);
    setTimeout(() => t.remove(), kind === 'error' ? 7000 : 4500);
  };

  const init = () => {
    const main = document.querySelector('main.admin');
    if (!main || main.dataset.shellReady) return;
    main.dataset.shellReady = 'true';

    const meta = document.querySelector('meta[name="mayfair-staff"]');
    const legacyNav = main.querySelector(':scope > nav.admin-nav');
    const legacyLinks = legacyNav ? [...legacyNav.querySelectorAll('a')] : [];
    const signedIn = main.querySelector('.muted')?.textContent.match(/Signed in as (.+?) · (\w+)/);
    const role =
      meta?.getAttribute('content') || signedIn?.[2] || LS.get('mayfair.dashboard.role') || '';
    const person = meta?.dataset.name || signedIn?.[1] || 'Staff';
    if (role) LS.set('mayfair.dashboard.role', role);
    const path = location.pathname.replace(/\/+$/, '') || '/';

    // Menu: canonical groups + any legacy link that is not part of them (nothing is lost).
    const known = new Set([
      ...GROUPS.flatMap((g) => g.items.map((i) => i.href)),
      ...ACCOUNT.map((a) => a.href),
    ]);
    const extras = legacyLinks
      .filter((a) => !known.has(a.getAttribute('href')) && a.getAttribute('href') !== '/dashboard')
      .map((a) => ({
        label: a.textContent.trim(),
        href: a.getAttribute('href'),
        icon: 'link',
        match: [a.pathname],
      }));
    const staffLinkOnPage = legacyLinks.some((a) => a.pathname.startsWith('/dashboard/staff'));
    const groups = GROUPS.map((g) => ({
      ...g,
      items: g.items.filter((i) => !i.role || i.role === role || staffLinkOnPage),
    })).filter((g) => g.items.length);
    if (extras.length) groups.push({ name: 'More', items: extras });
    const all = groups.flatMap((g) => g.items.map((i) => ({ ...i, group: g.name })));
    const current = all
      .filter((i) => isCurrent(i, path))
      .sort((a, b) => (b.match?.[0] || b.href).length - (a.match?.[0] || a.href).length)[0];

    // Sidebar
    const shell = el('div', 'workspace-shell');
    const sidebar = el('aside', 'workspace-sidebar');
    sidebar.id = 'workspace-sidebar';
    sidebar.setAttribute('aria-label', 'Workspace navigation');
    sidebar.innerHTML =
      '<a class="workspace-brand" href="/dashboard"><span class="workspace-brand-mark">M</span><span><strong>Mayfair</strong><small>STAFF WORKSPACE</small></span></a>';
    const logoMeta = document.querySelector('meta[name="mf-logo"]');
    if (logoMeta && logoMeta.content) {
      const mark = sidebar.querySelector('.workspace-brand-mark');
      if (mark) {
        const logo = document.createElement('img');
        logo.src = logoMeta.content;
        logo.alt = logoMeta.dataset.alt || '';
        logo.className = 'brand-logo-image';
        mark.replaceWith(logo);
      }
    }
    const searchWrap = el(
      'label',
      'workspace-search',
      `${svg('search').replace('<svg', '<svg width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8"')}<input type="search" placeholder="Filter menu…" aria-label="Filter dashboard menu" autocomplete="off"><kbd>/</kbd>`,
    );
    const filter = searchWrap.querySelector('input');
    const nav = el('nav', 'workspace-nav');
    nav.setAttribute('aria-label', 'Dashboard sections');
    for (const g of groups) {
      nav.append(el('p', 'workspace-nav-label', esc(g.name)));
      for (const i of g.items) {
        const a = el('a', 'workspace-link', `${svg(i.icon)}<span>${esc(i.label)}</span>`);
        a.href = i.href;
        a.title = i.label;
        if (current && current.href === i.href) a.setAttribute('aria-current', 'page');
        nav.append(a);
      }
    }
    const empty = el('p', 'workspace-empty', 'No menu items match.');
    empty.hidden = true;
    nav.append(empty);
    filter.addEventListener('input', () => {
      const q = filter.value.trim().toLowerCase();
      let any = false;
      let label = null;
      let groupVisible = false;
      const flush = () => {
        if (label) label.hidden = !groupVisible;
      };
      for (const n of nav.children) {
        if (n.classList.contains('workspace-nav-label')) {
          flush();
          label = n;
          groupVisible = false;
        } else if (n.classList.contains('workspace-link')) {
          const hit = !q || n.textContent.toLowerCase().includes(q);
          n.hidden = !hit;
          groupVisible = groupVisible || hit;
          any = any || hit;
        }
      }
      flush();
      empty.hidden = any;
    });
    filter.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        const first = [...nav.querySelectorAll('.workspace-link')].find((a) => !a.hidden);
        if (first) location.href = first.href;
      }
      if (e.key === 'Escape') {
        filter.value = '';
        filter.dispatchEvent(new Event('input'));
        filter.blur();
      }
    });
    const initials =
      person
        .split(/[\s@.]+/)
        .filter(Boolean)
        .slice(0, 2)
        .map((p) => p[0].toUpperCase())
        .join('') || 'M';
    const user = el(
      'div',
      'workspace-user',
      `<span class="workspace-avatar">${esc(initials)}</span><span class="workspace-user-meta"><strong>${esc(person)}</strong><span>${esc(role.replace(/_/g, ' ') || 'staff')}</span></span>`,
    );
    const account = el(
      'div',
      'workspace-account',
      ACCOUNT.map((a) => `<a href="${a.href}">${esc(a.label)}</a>`).join(''),
    );
    sidebar.append(searchWrap, nav, user, account);

    // Topbar
    const menuBtn = el('button', 'ws-icon-btn workspace-menu-toggle', svg('menu'));
    menuBtn.type = 'button';
    menuBtn.setAttribute('aria-label', 'Open menu');
    menuBtn.setAttribute('aria-expanded', 'false');
    menuBtn.setAttribute('aria-controls', 'workspace-sidebar');
    const collapseBtn = el('button', 'ws-icon-btn workspace-collapse', svg('sidebar'));
    collapseBtn.type = 'button';
    collapseBtn.setAttribute('aria-label', 'Collapse or expand sidebar');
    const h1 = main.querySelector('h1');
    const pageTitle = current?.label || h1?.textContent.trim() || 'Dashboard';
    const crumbs = el(
      'div',
      'workspace-breadcrumb',
      `<span>Workspace</span>${current && current.group !== 'Workspace' ? `<i>/</i><span>${esc(current.group)}</span>` : ''}<i>/</i><b>${esc(pageTitle)}</b>`,
    );
    const palette = el(
      'button',
      'ws-palette-trigger',
      `${svg('search')}<span>Search pages and actions…</span><kbd class="ws-kbd">Ctrl K</kbd>`,
    );
    palette.type = 'button';
    const themes = el('div', 'ws-themes');
    themes.setAttribute('role', 'group');
    themes.setAttribute('aria-label', 'Colour theme');
    for (const t of THEMES) {
      const b = el('button', 'ws-theme-dot');
      b.type = 'button';
      b.dataset.themeSet = t;
      b.title = `${t[0].toUpperCase()}${t.slice(1)} theme`;
      b.setAttribute('aria-label', `${t} theme`);
      b.addEventListener('click', () => {
        LS.set(THEME_KEY, t);
        applyTheme(t);
      });
      themes.append(b);
    }
    const topbar = el('header', 'workspace-topbar');
    const actions = el('div', 'workspace-top-actions');
    actions.append(palette, themes);
    topbar.append(menuBtn, collapseBtn, crumbs, actions);

    // Content: page head + everything else from the page (event listeners move with the nodes).
    const content = el('main', 'workspace-content');
    content.id = 'workspace-content';
    const children = [...main.children].filter((n) => n !== legacyNav);
    const eyebrow = children.find((n) => n.classList?.contains('eyebrow'));
    const lead =
      h1 &&
      children.find(
        (n) =>
          n.tagName === 'P' &&
          n !== eyebrow &&
          !n.hasAttribute('role') &&
          h1.compareDocumentPosition(n) & Node.DOCUMENT_POSITION_FOLLOWING,
      );
    const head = el('div', 'page-head');
    head.append(el('p', 'eyebrow', esc(current?.group || 'Staff workspace')));
    if (h1) head.append(h1);
    if (lead) head.append(lead);
    if (eyebrow) eyebrow.remove();
    content.append(head);
    for (const n of children) if (n !== eyebrow && n !== h1 && n !== lead) content.append(n);

    const mainCol = el('div', 'workspace-main');
    const overlay = el('div', 'ws-overlay');
    mainCol.append(topbar, content);
    shell.append(sidebar, mainCol, overlay);
    main.replaceWith(shell);
    if (LS.get(SIDEBAR_KEY) === 'collapsed') shell.classList.add('is-collapsed');
    applyTheme(LS.get(THEME_KEY));

    const setMenu = (open) => {
      shell.classList.toggle('workspace-menu-open', open);
      menuBtn.setAttribute('aria-expanded', String(open));
    };
    menuBtn.addEventListener('click', () =>
      setMenu(!shell.classList.contains('workspace-menu-open')),
    );
    overlay.addEventListener('click', () => setMenu(false));
    nav.addEventListener('click', (e) => {
      if (e.target.closest('a')) setMenu(false);
    });
    collapseBtn.addEventListener('click', () => {
      const c = shell.classList.toggle('is-collapsed');
      LS.set(SIDEBAR_KEY, c ? 'collapsed' : 'open');
    });

    setupPalette(all, palette);
    document.addEventListener('keydown', (e) => {
      const typing =
        ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName) ||
        document.activeElement?.isContentEditable;
      if (e.key === 'Escape') setMenu(false);
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        palette.click();
      } else if (e.key === '/' && !typing && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        palette.click();
      }
    });

    enhanceContent(content);
    new MutationObserver((records) => {
      for (const r of records)
        for (const n of r.addedNodes) if (n.nodeType === 1) enhanceButtons(n);
    }).observe(content, { childList: true, subtree: true });
  };

  // Command palette
  const setupPalette = (items, trigger) => {
    const root = el('div', 'ws-palette');
    root.hidden = true;
    root.innerHTML =
      '<div class="ws-palette-box" role="dialog" aria-modal="true" aria-label="Search pages and actions"><input type="search" placeholder="Jump to a page or run an action…" aria-label="Search" autocomplete="off"><ul class="ws-palette-list" role="listbox"></ul><div class="ws-palette-foot"><span>↑↓ to move</span><span>Enter to open</span><span>Esc to close</span></div></div>';
    document.body.append(root);
    const input = root.querySelector('input');
    const list = root.querySelector('ul');
    const entries = [
      ...items.map((i) => ({
        label: i.label,
        href: i.href,
        icon: i.icon,
        hint: i.group,
        kw: i.kw,
      })),
      ...ACTIONS.map((a) => ({ ...a, hint: 'Action' })),
      ...THEMES.map((t) => ({
        label: `Theme: ${t[0].toUpperCase()}${t.slice(1)}`,
        theme: t,
        icon: 'palette',
        hint: 'Appearance',
        kw: 'colour color dark light',
      })),
    ];
    let shown = [];
    let index = 0;
    const draw = () => {
      const q = input.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
      shown = entries
        .filter((e) =>
          q.every((t) => `${e.label} ${e.hint} ${e.kw || ''}`.toLowerCase().includes(t)),
        )
        .slice(0, 12);
      index = Math.min(index, Math.max(shown.length - 1, 0));
      list.innerHTML = shown.length
        ? shown
            .map(
              (e, i) =>
                `<li role="presentation"><a role="option" href="${e.href ? esc(e.href) : '#'}" data-i="${i}" aria-selected="${i === index}">${svg(e.icon)}<span>${esc(e.label)}</span><small>${esc(e.hint)}</small></a></li>`,
            )
            .join('')
        : '<li class="ws-palette-none">Nothing matches. Try “opportunity”, “nda” or “settings”.</li>';
    };
    const close = () => {
      root.hidden = true;
      trigger.focus();
    };
    const choose = (i) => {
      const e = shown[i];
      if (!e) return;
      if (e.theme) {
        LS.set(THEME_KEY, e.theme);
        applyTheme(e.theme);
        close();
      } else location.href = e.href;
    };
    const move = (delta) => {
      index = Math.max(0, Math.min(index + delta, shown.length - 1));
      draw();
      list.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
    };
    trigger.addEventListener('click', () => {
      root.hidden = false;
      input.value = '';
      index = 0;
      draw();
      input.focus();
    });
    input.addEventListener('input', () => {
      index = 0;
      draw();
    });
    root.addEventListener('click', (e) => {
      const a = e.target.closest('a[data-i]');
      if (a) {
        e.preventDefault();
        choose(Number(a.dataset.i));
      } else if (e.target === root) close();
    });
    root.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        close();
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        move(1);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        move(-1);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        choose(index);
      }
    });
  };

  const DANGER = /^(remove|delete|reject|revoke|archive|disable|deactivate)\b/i;
  const enhanceButtons = (root) => {
    const buttons = root.matches?.('button')
      ? [root]
      : [...(root.querySelectorAll?.('button') || [])];
    for (const b of buttons) if (DANGER.test(b.textContent.trim())) b.classList.add('is-danger');
  };

  const slugify = (s) =>
    String(s || '')
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 80);

  const enhanceContent = (content) => {
    enhanceButtons(content);

    // Notices become coloured banners plus toasts; a success message clears the "unsaved" state.
    const ERR =
      /(could not|unable|failed|error|invalid|must |required\b|denied|select an|enter a|confirm the|set classification|save the listing|not allowed|request failed)/i;
    const OK =
      /(saved|created|loaded|updated|uploaded|removed|published|approved|rejected|revoked|activated)/i;
    const flows = [...content.querySelectorAll('form[data-flow]')];
    const dirty = new Set();
    const setState = (form, isDirty) => {
      if (isDirty) dirty.add(form);
      else dirty.delete(form);
      const chip = form.querySelector('.flow-state');
      if (chip) {
        chip.textContent = isDirty ? 'Unsaved changes' : 'All changes saved';
        chip.classList.toggle('is-dirty', isDirty);
      }
    };
    const watchNotice = (n) => {
      let last = n.textContent;
      new MutationObserver(() => {
        const text = n.textContent.trim();
        if (!text || text === last) return;
        last = text;
        const bad = ERR.test(text);
        n.classList.toggle('is-error', bad);
        n.classList.toggle('is-ok', !bad && OK.test(text));
        if (!/…$/.test(text)) toast(text, bad ? 'error' : OK.test(text) ? 'ok' : '');
        if (!bad && /(saved|created|loaded|updated)/i.test(text))
          flows.forEach((f) => setState(f, false));
      }).observe(n, { childList: true, characterData: true, subtree: true });
    };
    content.querySelectorAll('[role="status"]').forEach(watchNotice);

    // Character counters on long fields.
    for (const f of content.querySelectorAll('form input[maxlength], form textarea[maxlength]')) {
      const max = Number(f.getAttribute('maxlength'));
      if (!(max >= 80) || f.type === 'hidden') continue;
      const c = el('span', 'ws-count');
      c.setAttribute('aria-hidden', 'true');
      const ideal = f.name === 'seoTitle' ? 60 : f.name === 'seoDescription' ? 160 : 0;
      const upd = () => {
        const n = f.value.length;
        c.textContent = `${n} / ${max}${ideal ? ` · aim for under ${ideal}` : ''}`;
        c.classList.toggle('is-warn', !!ideal && n > ideal);
      };
      f.insertAdjacentElement('afterend', c);
      f.addEventListener('input', upd);
      f.form?.addEventListener('reset', () => setTimeout(upd));
      f._wsRefresh = upd;
      upd();
    }

    for (const form of flows) {
      form.addEventListener('input', (e) => {
        if (e.isTrusted) setState(form, true);
      });
      form.addEventListener('change', (e) => {
        if (e.isTrusted) setState(form, true);
      });
      form.addEventListener('reset', () => setState(form, false));

      const title = form.elements.namedItem('title');
      const slug = form.elements.namedItem('slug');
      const idField = form.elements.namedItem('id');
      if (title && slug && slug.tagName === 'INPUT') {
        let touched = false;
        slug.addEventListener('input', (e) => {
          if (e.isTrusted) touched = true;
        });
        form.addEventListener('reset', () => {
          touched = false;
        });
        title.addEventListener('input', () => {
          if (!touched && !(idField && idField.value)) slug.value = slugify(title.value);
        });
      }

      const seoT = form.elements.namedItem('seoTitle');
      const seoD = form.elements.namedItem('seoDescription');
      if (seoT && seoD) {
        const box = el(
          'div',
          'serp',
          '<small>Search result preview</small><div class="serp-url"></div><div class="serp-title"></div><div class="serp-desc"></div>',
        );
        (seoD.closest('label') || seoD).insertAdjacentElement('afterend', box);
        const upd = () => {
          const base = form.dataset.serpPath || '/';
          const s = slug ? slug.value : '';
          box.querySelector('.serp-url').textContent =
            `${location.origin}${base.replace('{slug}', s || '…')}`;
          box.querySelector('.serp-title').textContent = (
            seoT.value ||
            form.elements.namedItem('title')?.value ||
            'Page title'
          ).slice(0, 70);
          const fallback =
            form.elements.namedItem('description')?.value ||
            form.elements.namedItem('summary')?.value ||
            '';
          box.querySelector('.serp-desc').textContent = (
            seoD.value ||
            fallback ||
            'Add a description so searchers know what this page offers.'
          ).slice(0, 170);
        };
        form.addEventListener('input', upd);
        form._wsRefresh = upd;
        upd();
      }
    }
    // Edit buttons fill fields programmatically (no input events); refresh derived UI shortly after.
    setInterval(() => {
      content
        .querySelectorAll('input[maxlength], textarea[maxlength]')
        .forEach((f) => f._wsRefresh?.());
      flows.forEach((f) => f._wsRefresh?.());
    }, 900);

    // Ctrl/Cmd+S saves the form in focus (or the only editor form on the page).
    document.addEventListener('keydown', (e) => {
      if (!((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's')) return;
      const form =
        document.activeElement?.closest?.('form[data-flow]') ||
        (flows.length === 1 ? flows[0] : null);
      if (!form) return;
      e.preventDefault();
      form.requestSubmit();
    });
    window.addEventListener('beforeunload', (e) => {
      if (dirty.size) {
        e.preventDefault();
        e.returnValue = '';
      }
    });

    // Settings: colour swatches and live JSON validation.
    for (const f of content.querySelectorAll('textarea[name$="_color"]')) {
      const label = f.closest('label')?.querySelector('span');
      if (!label) continue;
      const sw = el('i', 'ws-swatch');
      label.append(sw);
      const upd = () => {
        const v = f.value.trim();
        sw.hidden = !(v && CSS.supports('color', v));
        if (!sw.hidden) sw.style.background = v;
      };
      f.addEventListener('input', upd);
      upd();
    }
    // Fields that used to need JSON get visual editors (menu links, sections, form fields).
    if (
      content.querySelector(
        'textarea[name$="_navigation"], textarea[name$="_sections"], textarea[name="fieldsJson"]',
      )
    ) {
      const editorScript = document.createElement('script');
      editorScript.src = '/static/js/dashboard-json-editors.js';
      editorScript.defer = true;
      document.head.append(editorScript);
    }
    for (const f of content.querySelectorAll(
      'textarea[name$="_navigation"], textarea[name$="_sections"], textarea[name="fieldsJson"]',
    )) {
      const msg = el('span', 'ws-field-msg');
      msg.hidden = true;
      f.insertAdjacentElement('afterend', msg);
      f.addEventListener('input', () => {
        try {
          JSON.parse(f.value || 'null');
          msg.hidden = true;
          f.removeAttribute('aria-invalid');
        } catch (err) {
          msg.hidden = false;
          msg.textContent = `Not valid JSON yet: ${err.message}`;
          f.setAttribute('aria-invalid', 'true');
        }
      });
    }

    // Quick filters for dynamic lists and long tables.
    const listSelectors = [
      '#buyers',
      '#grants',
      '#requests',
      '#task-list',
      '#jobs',
      '#managed-pages',
      '#managed-forms',
      '#nda-template-list',
      '#managed-submissions',
    ];
    for (const sel of listSelectors) {
      const c = content.querySelector(sel);
      if (c) addFilter(c, ':scope > *', false);
    }
    for (const table of content.querySelectorAll('table')) {
      if (table.querySelectorAll('tbody tr').length >= 6 && !table.closest('form'))
        addFilter(table, 'tbody tr', true);
    }
  };

  const addFilter = (container, itemSel, isTable) => {
    const box = el(
      'div',
      'ws-filter',
      `${svg('search')}<input type="search" placeholder="Filter this list…" aria-label="Filter this list" autocomplete="off">`,
    );
    const none = el('p', 'ws-filter-empty', 'Nothing matches that filter.');
    none.hidden = true;
    (isTable
      ? container.closest('.overflow-x-auto') || container
      : container
    ).insertAdjacentElement('beforebegin', box);
    box.insertAdjacentElement('afterend', none);
    const input = box.querySelector('input');
    const items = () => [...container.querySelectorAll(itemSel)];
    const apply = () => {
      const q = input.value.trim().toLowerCase();
      let visible = 0;
      for (const i of items()) {
        const hit = !q || i.textContent.toLowerCase().includes(q);
        i.dataset.wsHidden = String(!hit);
        if (hit) visible++;
      }
      none.hidden = !(q && visible === 0);
    };
    const sync = () => {
      box.hidden = !isTable && items().length < 4 && !input.value;
    };
    input.addEventListener('input', apply);
    if (!isTable)
      new MutationObserver(() => {
        sync();
        apply();
      }).observe(container, { childList: true });
    sync();
  };

  window.mayfairWorkspace = { toast };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
