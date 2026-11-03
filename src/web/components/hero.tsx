import { safeUrl, isHexColor } from '../../site-content/fields';
import type { Row } from '../../site-content/types';
import { flag, text } from './escape';

const OVERLAY: Record<string, string> = { none: '0', light: '.25', medium: '.45', strong: '.65' };

/** Home page hero, driven entirely by the staff-managed "hero" content. */
export function Hero({ hero }: { hero: Row }) {
  const layout = ['split', 'centered', 'image'].includes(text(hero, 'layout')) ? text(hero, 'layout') : 'split';
  const bgImage = safeUrl(text(hero, 'backgroundImage'));
  const bgColor = isHexColor(text(hero, 'backgroundColor')) ? text(hero, 'backgroundColor') : '';
  const height = text(hero, 'height');
  const classes = ['hero', `hero--${layout}`];
  if (text(hero, 'align') === 'center') classes.push('hero--align-center');
  if (height === 'tall' || height === 'screen') classes.push(`hero--${height}`);
  const styles: string[] = [];
  if (bgColor) styles.push(`background-color:${bgColor}`);
  if (bgImage && layout !== 'split') styles.push(`background-image:url("${bgImage.replace(/"/g, '%22')}")`);
  if (layout === 'image') styles.push(`--hero-overlay:${OVERLAY[text(hero, 'overlay')] ?? '.45'}`);
  const primaryUrl = safeUrl(text(hero, 'primaryUrl'));
  const secondaryUrl = safeUrl(text(hero, 'secondaryUrl'));
  const emphasis = text(hero, 'headlineEmphasis');
  const showArt = layout === 'split' && flag(hero, 'showArt');
  return (
    <section class={classes.join(' ')} style={styles.join(';') || undefined}>
      <div class="container hero-grid">
        <div class="hero-copy">
          {text(hero, 'eyebrow') && (
            <span class="eyebrow">
              <span class="eyebrow-line" /> {text(hero, 'eyebrow')}
            </span>
          )}
          {(text(hero, 'headline') || emphasis) && (
            <h1>
              {text(hero, 'headline')} {emphasis && <em>{emphasis}</em>}
            </h1>
          )}
          {text(hero, 'lead') && <p class="hero-lead">{text(hero, 'lead')}</p>}
          {((primaryUrl && text(hero, 'primaryLabel')) || (secondaryUrl && text(hero, 'secondaryLabel'))) && (
            <div class="hero-actions">
              {primaryUrl && text(hero, 'primaryLabel') && (
                <a class="button button-primary" href={primaryUrl}>
                  {text(hero, 'primaryLabel')} <span aria-hidden="true">↗</span>
                </a>
              )}
              {secondaryUrl && text(hero, 'secondaryLabel') && (
                <a class="text-link" href={secondaryUrl}>
                  {text(hero, 'secondaryLabel')} <span aria-hidden="true">→</span>
                </a>
              )}
            </div>
          )}
          {text(hero, 'note') && (
            <div class="hero-note">
              <span class="status-dot" /> {text(hero, 'note')}
            </div>
          )}
        </div>
        {showArt && (
          <div class="hero-art" aria-hidden="true">
            <div class="art-sun" />
            <div class="art-building art-building-back" />
            <div class="art-building art-building-front">
              <div class="art-columns" />
              <div class="art-door" />
            </div>
            <div class="art-ground" />
            {(text(hero, 'artKicker') || text(hero, 'artCaption')) && (
              <div class="art-caption">
                <span>{text(hero, 'artKicker')}</span>
                <strong>{text(hero, 'artCaption')}</strong>
              </div>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
