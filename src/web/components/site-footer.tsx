import { raw } from 'hono/html';
import { BRAND } from '../../brand/defaults';
import { safeUrl } from '../../site-content/fields';
import type { NavItem, SiteContent } from '../../site-content/types';
import { socialRowHtml } from '../branding';
import { socialInputs, telHref, type ContactSettings } from '../site-settings';
import { flag, text } from './escape';

/** href plus new-tab attributes for a managed navigation link (links were already validated when loaded). */
export function linkAttrs(item: NavItem): Record<string, string> {
  const href = safeUrl(item.url);
  return item['newTab'] === true ? { href, target: '_blank', rel: 'noopener noreferrer' } : { href };
}

/** Brand name and tagline, shared by the header and the footer. */
export function BrandCopy({ content }: { content: SiteContent }) {
  const tagline = text(content.footer, 'tagline');
  return (
    <span class="brand-copy">
      <strong>{BRAND.nameUpper}</strong>
      {tagline && <small>{tagline}</small>}
    </span>
  );
}

/**
 * The one site footer. Public pages render it through BaseLayout; dashboard, buyer, seller and sign-in pages get the
 * same markup injected by withSharedFooter, so everything is edited in one place (Settings > Site content > Footer).
 */
export function SiteFooter({ content, contact }: { content: SiteContent; contact: ContactSettings }) {
  const f = content.footer;
  const social = socialRowHtml(socialInputs(contact, contact.chairmanEmail), 'social-row footer-social');
  return (
    <footer class="site-footer">
      <div class="container footer-grid">
        <div>
          <a class="brand brand-footer" href="/">
            <span class="brand-mark">{BRAND.markLetter}</span>
            <BrandCopy content={content} />
          </a>
          {text(f, 'blurb') && <p>{text(f, 'blurb')}</p>}
          {social && raw(social)}
        </div>
        <div>
          <strong>{text(f, 'exploreHeading')}</strong>
          {content.navFooterExplore.map((item) => (
            <a {...linkAttrs(item)}>{item.label}</a>
          ))}
        </div>
        <div>
          <strong>{text(f, 'infoHeading')}</strong>
          {content.navFooterInfo.map((item) => (
            <a {...linkAttrs(item)}>{item.label}</a>
          ))}
        </div>
        <div>
          <strong>{text(f, 'contactHeading')}</strong>
          <a href={telHref(contact.phoneMobile)}>{contact.phoneMobile}</a>
          <a href={telHref(contact.phoneOffice)}>{contact.phoneOffice}</a>
          <a href={`mailto:${contact.email}`}>{contact.email}</a>
          {flag(f, 'showAccountLinks') && (
            <>
              <a href="/account">Buyer sign in</a>
              <a href="/admin/login">Staff sign in</a>
            </>
          )}
        </div>
      </div>
      <div class="container footer-bottom">
        <span>{text(f, 'copyright').replace('{year}', String(new Date().getUTCFullYear()))}</span>
        <span>
          {text(f, 'disclaimer')}{' '}
          {text(f, 'cookieLabel') && (
            <a href="/legal/cookies" data-cookie-settings>
              {text(f, 'cookieLabel')}
            </a>
          )}
        </span>
      </div>
    </footer>
  );
}
