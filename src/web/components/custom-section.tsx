import { isHexColor, safeUrl } from '../../site-content/fields';
import type { Row } from '../../site-content/types';
import { paragraphs, text } from './escape';

/** "Title | Text | /link" lines become cards. Invalid links are dropped. */
export function parseCards(value: string): Array<{ title: string; body: string; url: string }> {
  return value
    .split('\n')
    .map((line) => line.split('|').map((part) => part.trim()))
    .filter((parts) => parts[0])
    .slice(0, 12)
    .map(([title = '', body = '', url = '']) => ({ title, body, url: safeUrl(url) }));
}

/** A staff-created home page section (text, text and image, cards or call-out banner). */
export function CustomSection({ section }: { section: Row }) {
  const layout = text(section, 'layout');
  const tone = text(section, 'tone');
  const image = safeUrl(text(section, 'imageUrl'));
  const bgImage = safeUrl(text(section, 'backgroundImage'));
  const bgColor = isHexColor(text(section, 'backgroundColor')) ? text(section, 'backgroundColor') : '';
  const anchor = /^[a-z0-9][a-z0-9-]{0,39}$/.test(text(section, 'anchor')) ? text(section, 'anchor') : undefined;
  const classes = ['cs', 'managed-section'];
  if (bgImage) classes.push('cs--image');
  else if (['muted', 'dark', 'accent'].includes(tone)) classes.push(`cs--${tone}`);
  const styles: string[] = [];
  if (bgColor && !bgImage) styles.push(`background-color:${bgColor}`);
  if (bgImage) styles.push(`background-image:url("${bgImage.replace(/"/g, '%22')}")`);
  const ctaUrl = safeUrl(text(section, 'ctaUrl'));
  const cta = ctaUrl && text(section, 'ctaLabel') && (
    <a class="button button-primary" href={ctaUrl}>
      {text(section, 'ctaLabel')}
    </a>
  );
  const copy = (
    <div class={layout === 'cta' ? 'cs-cta' : undefined}>
      {text(section, 'eyebrow') && <span class="eyebrow">{text(section, 'eyebrow')}</span>}
      {text(section, 'heading') && <h2>{text(section, 'heading')}</h2>}
      {paragraphs(text(section, 'body')).map((p) => (
        <p>{p}</p>
      ))}
      {cta}
    </div>
  );
  const cards = layout === 'cards' ? parseCards(text(section, 'cards')) : [];
  return (
    <section class={classes.join(' ')} id={anchor} style={styles.join(';') || undefined}>
      <div class="container">
        {layout === 'split' || layout === 'split-reverse' ? (
          <div class={layout === 'split-reverse' ? 'cs-split cs-split--reverse' : 'cs-split'}>
            {copy}
            {image && <img src={image} alt={text(section, 'imageAlt')} loading="lazy" />}
          </div>
        ) : (
          copy
        )}
        {cards.length > 0 && (
          <div class="cs-cards">
            {cards.map((card) => (
              <article class="cs-card">
                <h3>{card.title}</h3>
                {card.body && <p>{card.body}</p>}
                {card.url && (
                  <a class="text-link" href={card.url}>
                    Learn more <span aria-hidden="true">→</span>
                  </a>
                )}
              </article>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
