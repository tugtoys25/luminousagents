/**
 * Conservative parser for the free-text asking prices imported from the legacy site
 * ("£450 Million", "55.000.000 Euros", "7m Euros"). It never guesses: anything with mixed or
 * irregular separators, a multiplier combined with digit grouping, or no recognisable currency
 * is reported as `ambiguous` so a person confirms it. Only `exact` results may feed price_minor.
 */
export type Currency = 'GBP' | 'EUR' | 'USD';
export type PriceParse =
  | { kind: 'exact'; currency: Currency; minor: number }
  | { kind: 'on_request' }
  | { kind: 'empty' }
  | { kind: 'ambiguous'; reason: string };

const CURRENCY_WORDS: Array<[RegExp, Currency]> = [
  [/\b(pounds?|sterling|gbp)\b/, 'GBP'],
  [/\b(euros?|eur)\b/, 'EUR'],
  [/\b(dollars?|usd)\b/, 'USD'],
];
const SYMBOLS: Record<string, Currency> = { '£': 'GBP', '€': 'EUR', $: 'USD' };
const MULTIPLIERS: Record<string, number> = {
  k: 1e3, thousand: 1e3, m: 1e6, mn: 1e6, million: 1e6, b: 1e9, bn: 1e9, billion: 1e9,
};

function ambiguous(reason: string): PriceParse {
  return { kind: 'ambiguous', reason };
}

function parseDigits(raw: string, hasMultiplier: boolean): number | string {
  const digits = raw.replace(/\s+/g, '');
  if (!/^\d[\d.,]*$/.test(digits)) return 'no usable number';
  const seps = digits.match(/[.,]/g) ?? [];
  if (seps.length === 0) return Number(digits);
  if (hasMultiplier) {
    // "7.5m" is fine; "240,000,000m" is a unit contradiction.
    return /^\d+\.\d+$/.test(digits) ? Number(digits) : 'multiplier combined with digit grouping';
  }
  const distinct = new Set(seps);
  if (distinct.size > 1) return 'mixed thousands and decimal separators';
  const sep = [...distinct][0] as string;
  if (!new RegExp(`^\\d{1,3}(\\${sep}\\d{3})+$`).test(digits))
    return 'separator groups are not thousands groups';
  return Number(digits.split(sep).join(''));
}

export function parsePriceText(text: string | null | undefined): PriceParse {
  const input = (text ?? '').trim();
  if (!input) return { kind: 'empty' };
  const lower = input.toLowerCase();
  if (/price\s+on\s+(request|application)|\bpoa\b|undisclosed/.test(lower)) return { kind: 'on_request' };

  let currency: Currency | undefined;
  const symbol = lower.match(/[£€$]/)?.[0];
  if (symbol) currency = SYMBOLS[symbol];
  for (const [pattern, code] of CURRENCY_WORDS) {
    if (pattern.test(lower)) {
      if (currency && currency !== code) return ambiguous('conflicting currency markers');
      currency = code;
    }
  }
  if (!currency) return ambiguous('no recognisable currency');

  const match = lower.match(/(\d[\d.,\s]*\d|\d)\s*(billion|million|thousand|bn|mn|k|m|b)?(?![a-z])/);
  if (!match) return ambiguous('no number found');
  const [, numberPart, unit] = match;
  const multiplier = unit ? (MULTIPLIERS[unit] ?? 1) : 1;
  const value = parseDigits(numberPart as string, Boolean(unit));
  if (typeof value === 'string') return ambiguous(value);

  const remainder = lower
    .replace(match[0], ' ')
    .replace(/[£€$]/g, ' ')
    .replace(/\b(pounds?|sterling|gbp|euros?|eur|dollars?|usd|approx\.?|approximately|circa|c\.|from|offers|over)\b/g, ' ')
    .replace(/[\s,.:;()-]+/g, ' ')
    .trim();
  if (remainder) return ambiguous(`unrecognised text: "${remainder.slice(0, 40)}"`);

  const minor = Math.round(value * multiplier * 100);
  if (!Number.isSafeInteger(minor) || minor <= 0) return ambiguous('value out of range');
  return { kind: 'exact', currency, minor };
}

export function formatMinor(minor: number, currency: Currency): string {
  const symbol = { GBP: '£', EUR: '€', USD: '$' }[currency];
  const major = minor / 100;
  if (major >= 1e9) return `${symbol}${trim(major / 1e9)} billion`;
  if (major >= 1e6) return `${symbol}${trim(major / 1e6)} million`;
  return `${symbol}${major.toLocaleString('en-GB', { maximumFractionDigits: 0 })}`;
}
const trim = (n: number) => String(Number(n.toFixed(2)));
