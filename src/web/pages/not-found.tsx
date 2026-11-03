import { BRAND } from '../../brand/defaults';
import type { Env } from '../../env';
import { safeUrl } from '../../site-content/fields';
import { loadSiteContent } from '../../site-content/load';
import { text } from '../components/escape';
import { BaseLayout } from '../layouts/base';
import { loadContact } from '../site-settings';
import { SITE_URL } from './public-shared';

/** Paths that belong to APIs, staff tools or files: they always keep the JSON 404. */
const NON_PAGE_PREFIXES = ['/api/', '/dashboard', '/account', '/admin', '/media/', '/static/'];

/** True for a browser asking for a web page (GET or HEAD, HTML accepted, not an API or file path). */
export function wantsNotFoundPage(request: Request): boolean {
  if (request.method !== 'GET' && request.method !== 'HEAD') return false;
  const path = new URL(request.url).pathname;
  if (NON_PAGE_PREFIXES.some((prefix) => path === prefix.replace(/\/$/, '') || path.startsWith(prefix))) return false;
  return (request.headers.get('accept') ?? '').includes('text/html');
}

/**
 * The branded "Page not found" page, with the site header, footer and staff-editable wording
 * (Settings > Site content > Page not found). Returns null when the request is not a page request,
 * so the caller can keep answering API and file requests with JSON.
 */
export async function notFoundPage(env: Env, request: Request): Promise<Response | null> {
  if (!wantsNotFoundPage(request)) return null;
  const [contact, content] = await Promise.all([loadContact(env), loadSiteContent(env)]);
  const copy = content.notFound;
  const heading = text(copy, 'heading') || 'Page not found';
  const message = text(copy, 'message');
  const buttons = [
    { label: text(copy, 'primaryLabel'), url: safeUrl(copy['primaryUrl']), cls: 'button button-dark' },
    { label: text(copy, 'secondaryLabel'), url: safeUrl(copy['secondaryUrl']), cls: 'button button-primary' },
  ].filter((b) => b.label && b.url);
  const eyebrow = text(copy, 'eyebrow');
  const page = (
    <BaseLayout
      siteUrl={env.PUBLIC_BASE_URL || SITE_URL}
      contact={contact}
      content={content}
      title={`${heading} | ${BRAND.name}`}
      description="The page you requested could not be found."
      noindex
    >
      <section class="section">
        <div class="container empty-state not-found">
          {eyebrow ? <p class="eyebrow">{eyebrow}</p> : null}
          <h1>{heading}</h1>
          {message ? <p>{message}</p> : null}
          {buttons.map((b) => (
            <a class={b.cls} href={b.url}>
              {b.label}
            </a>
          ))}
        </div>
      </section>
    </BaseLayout>
  );
  const html = await page.toString();
  return new Response(request.method === 'HEAD' ? null : html, {
    status: 404,
    headers: { 'Content-Type': 'text/html; charset=UTF-8' },
  });
}
