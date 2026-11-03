import type { Env } from '../env';
import { flag } from './components/escape';
import { SiteFooter } from './components/site-footer';
import { loadSiteContent } from '../site-content/load';
import { loadContact } from './site-settings';

const escapeHtml = (value: string) =>
  value.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);

const FOOTER_CSS = '<link rel="stylesheet" href="/static/css/shared-footer.css"><link rel="stylesheet" href="/static/css/social.css">';

/**
 * Adds the managed site footer to HTML pages that do not render their own (dashboard, buyer, seller and sign-in pages).
 * Dashboard pages get it inside a <template> that the workspace shell places under the page content.
 * Pages that already have a footer, or that staff turned the footer off for, are returned unchanged.
 */
export async function withSharedFooter(env: Env, html: string, opts: { dashboard: boolean; siteName?: string }): Promise<string> {
  if (!html.includes('</body>') || html.includes('class="site-footer"') || html.includes('id="shared-footer"')) return html;
  try {
    const [content, contact] = await Promise.all([loadSiteContent(env), loadContact(env)]);
    if (!flag(content.footer, opts.dashboard ? 'showOnDashboard' : 'showOnAccountPages')) return html;
    let footer = String(await (<SiteFooter content={content} contact={contact} />));
    if (opts.siteName) {
      footer = footer
        .replace(/Luminous Agents/g, () => escapeHtml(opts.siteName!))
        .replace(/LUMINOUS AGENTS/g, () => escapeHtml(opts.siteName!.toUpperCase()));
    }
    const block = opts.dashboard ? `<template id="shared-footer">${footer}</template>` : footer;
    const withCss = html.includes('</head>') ? html.replace('</head>', () => `${FOOTER_CSS}</head>`) : html;
    return withCss.replace('</body>', () => `${block}</body>`);
  } catch {
    return html;
  }
}
