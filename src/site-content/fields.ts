import type { FieldDef, Row, Value } from './types';

/** True when the text holds a control character (tab and newline are allowed only when `allowWhitespace`). */
function hasControl(value: string, allowWhitespace = false): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (allowWhitespace && (code === 9 || code === 10 || code === 13)) continue;
    if (code < 32 || code === 127) return true;
  }
  return false;
}

/** Same-site path, https address, or (when allowed) mailto:/tel:. Returns '' when unusable. */
export function safeUrl(value: unknown, allowContact = false): string {
  const v = typeof value === 'string' ? value.trim() : '';
  if (!v || v.length > 500 || hasControl(v) || /[\s"'<>\\]/.test(v)) return '';
  if (v.startsWith('#')) return /^#[A-Za-z0-9_-]{1,80}$/.test(v) ? v : '';
  if (v.startsWith('/')) return v.startsWith('//') ? '' : v;
  if (/^https:\/\/[^/]+/i.test(v)) return v;
  if (allowContact && /^(mailto|tel):[^\s]+$/i.test(v)) return v;
  return '';
}

export const isHexColor = (v: unknown): v is string => typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v);

export type FieldResult = { ok: true; value: Value } | { ok: false; message: string };

/** Validates one field value. Empty optional values are kept as '' / false / 0 so the built-in text does not return unexpectedly. */
export function validateField(field: FieldDef, input: unknown): FieldResult {
  const bad = (message: string): FieldResult => ({ ok: false, message: `${field.label}: ${message}` });
  switch (field.type) {
    case 'toggle':
      if (typeof input === 'boolean') return { ok: true, value: input };
      if (input === undefined || input === null || input === '') return { ok: true, value: false };
      return bad('must be on or off.');
    case 'number': {
      if (input === undefined || input === null || input === '') {
        return field.required ? bad('is required.') : { ok: true, value: field.min ?? 0 };
      }
      const n = typeof input === 'number' ? input : Number(input);
      if (!Number.isFinite(n)) return bad('must be a number.');
      if (n < (field.min ?? 0) || n > (field.max ?? 1_000_000)) return bad('is out of range.');
      return { ok: true, value: Math.round(n) };
    }
    case 'select': {
      const v = typeof input === 'string' ? input : '';
      const allowed = (field.options ?? []).map(([key]) => key);
      if (!v) return field.required ? bad('choose an option.') : { ok: true, value: allowed[0] ?? '' };
      return allowed.includes(v) ? { ok: true, value: v } : bad('unknown option.');
    }
    case 'color': {
      const v = typeof input === 'string' ? input.trim() : '';
      if (!v) return field.required ? bad('is required.') : { ok: true, value: '' };
      return isHexColor(v) ? { ok: true, value: v.toLowerCase() } : bad('use a #rrggbb colour.');
    }
    case 'url':
    case 'image': {
      const raw = typeof input === 'string' ? input.trim() : '';
      if (!raw) return field.required ? bad('is required.') : { ok: true, value: '' };
      const v = safeUrl(raw, field.type === 'url');
      return v ? { ok: true, value: v } : bad('use a site path such as /contact or an https:// address.');
    }
    default: {
      if (input !== undefined && input !== null && typeof input !== 'string') return bad('must be text.');
      const v = (typeof input === 'string' ? input : '').replace(/\r\n/g, '\n').trim();
      if (!v) return field.required ? bad('is required.') : { ok: true, value: '' };
      if (v.length > (field.max ?? 300)) return bad(`is too long (maximum ${field.max ?? 300} characters).`);
      if (hasControl(v, true)) return bad('contains unsupported characters.');
      return { ok: true, value: v };
    }
  }
}

/** Validates a whole item. Unknown keys are dropped; every declared field is present in the result. */
export function validateRow(
  fields: readonly FieldDef[],
  input: unknown,
): { ok: true; data: Row } | { ok: false; errors: string[] } {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { ok: false, errors: ['Send an object.'] };
  const source = input as Record<string, unknown>;
  const data: Row = {};
  const errors: string[] = [];
  for (const field of fields) {
    const result = validateField(field, source[field.name]);
    if (result.ok) data[field.name] = result.value;
    else errors.push(result.message);
  }
  return errors.length ? { ok: false, errors } : { ok: true, data };
}
