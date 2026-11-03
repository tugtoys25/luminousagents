import { validateRow } from './fields';
import type { CollectionDef, Row } from './types';

const ANCHOR = /^[a-z0-9][a-z0-9-]{0,39}$/;

/** Field validation plus the cross-field rules that a field list cannot express. */
export function validateItem(def: CollectionDef, input: unknown): { ok: true; data: Row } | { ok: false; errors: string[] } {
  const result = validateRow(def.fields, input);
  if (!result.ok) return result;
  const { data } = result;
  const errors: string[] = [];
  if (def.key === 'home_sections') {
    const anchor = typeof data['anchor'] === 'string' ? data['anchor'] : '';
    if (anchor && !ANCHOR.test(anchor)) errors.push('Anchor id: use lower-case letters, numbers and hyphens only.');
    if (data['type'] === 'custom' && !data['heading'] && !data['body'] && !data['cards'] && !data['imageUrl'])
      errors.push('A custom section needs a heading, text, cards or an image.');
    if (data['layout'] === 'cards' && data['type'] === 'custom' && !data['cards']) errors.push('Cards layout needs at least one card line.');
  }
  return errors.length ? { ok: false, errors } : { ok: true, data };
}

/** Public description of a collection for the dashboard (built-in defaults are served separately). */
export function describeCollection(def: CollectionDef) {
  return {
    key: def.key,
    label: def.label,
    group: def.group,
    help: def.help,
    kind: def.kind,
    titleField: def.titleField ?? null,
    maxItems: def.maxItems ?? 1,
    fields: def.fields,
  };
}
