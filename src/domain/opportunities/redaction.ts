/**
 * Sprint 32 — confidential price and financial-figure redaction.
 *
 * Pure functions with no Worker or database dependency, so the same logic is used by the
 * public serializer and by the regression tests that scan every legacy listing.
 *
 * Policy: for a viewer at tier 0 (public) and a listing whose `price_visibility` is not 1,
 * the asking price AND any other money amount written into free text (turnover, debt, rent,
 * deposits, funding) is replaced. This is deliberately conservative: public copy is
 * over-redacted rather than under-redacted, and staff always see the original text.
 *
 * This is a safety net, not a substitute for editorial review. Each listing still needs a
 * human review before publication (see docs/SPRINT_32_COMPLETION.md).
 */

export const AMOUNT_WITHHELD = '[amount withheld]';
export const PRICE_WITHHELD_PHRASE = 'Price available to qualified buyers';

const NUMBER = String.raw`\d(?:[\d.,]*\d)?`;
const CURRENCY_CODE = String.raw`(?:USD|GBP|EUR|CHF|AED|CAD|AUD)`;
const CURRENCY_SYMBOL = String.raw`(?:US\$|A\$|C\$|[$£€])`;
const CURRENCY_WORD = String.raw`(?:usd|gbp|eur|euros?|dollars?|pounds?|sterling)`;
const MAGNITUDE_WORD = String.raw`(?:million|billion|thousand|mn|bn)`;
const MAGNITUDE_LETTER = String.raw`(?:m|k)`;
const TRAILING_CURRENCY = String.raw`(?:\s?(?:US|USD|GBP|EUR|euros?|dollars?|pounds?)\b(?:\s+sterling\b)?)?`;

/** Ordered money patterns. Each is global and case-insensitive. */
const MONEY_PATTERNS: RegExp[] = [
  // Symbol- or code-led: $360,000,000 US · £25m · USD 5,000 · €1.2 million
  new RegExp(
    String.raw`(?:${CURRENCY_SYMBOL}|\b${CURRENCY_CODE}\b)\s?${NUMBER}(?:\s?(?:${MAGNITUDE_WORD}\b|${MAGNITUDE_LETTER}(?![a-z0-9])))?${TRAILING_CURRENCY}`,
    'gi',
  ),
  // Number plus a magnitude word: 95 million · 1.5 billion euros
  new RegExp(String.raw`(?<![\w.])${NUMBER}\s?${MAGNITUDE_WORD}\b${TRAILING_CURRENCY}`, 'gi'),
  // Number with an attached m/k suffix, only when a currency word follows: 250m euros · 26m Eur
  new RegExp(
    String.raw`(?<![\w.])${NUMBER}\s?${MAGNITUDE_LETTER}\s?${CURRENCY_WORD}\b(?:\s+sterling\b)?`,
    'gi',
  ),
  // Plain number followed by a currency word: 75,000 euros · 42.000.000 Pounds Sterling
  new RegExp(String.raw`(?<![\w.])${NUMBER}\s?${CURRENCY_WORD}\b(?:\s+sterling\b)?`, 'gi'),
];

/** "price 360000000", "asking price: 5", "priced at 12" — a bare number after a price keyword. */
const PRICE_CONNECTOR = String.raw`[\s:=~-]*(?:(?:is|was|of|at|now|from|to|increased|reduced|approx\.?|approximately|around|about|only)\s*)*`;
const PRICE_KEYWORD_PATTERN = new RegExp(
  String.raw`\b(?:asking\s+)?(?:price|priced|valued|valuation)\b${PRICE_CONNECTOR}${NUMBER}(?!\s*%)(?:\s?(?:${MAGNITUDE_WORD}\b|${MAGNITUDE_LETTER}(?![a-z0-9])))?`,
  'gi',
);

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Replace every money-like amount in a string. */
export function redactMoneyAmounts(value: string): string {
  let result = value;
  for (const pattern of MONEY_PATTERNS) {
    result = result.replace(pattern, AMOUNT_WITHHELD);
  }
  return result;
}

/** Redact the stored asking price, then every other money amount, then bare numbers after a price keyword. */
export function redactConfidentialText(value: string, priceText: string): string {
  if (!value) return value;
  let result = value;
  const exact = priceText.trim();
  if (exact) {
    result = result.replace(new RegExp(escapeRegExp(exact), 'gi'), AMOUNT_WITHHELD);
  }
  result = redactMoneyAmounts(result);
  result = result.replace(PRICE_KEYWORD_PATTERN, PRICE_WITHHELD_PHRASE);
  return result;
}

/** True when text still contains something that looks like a money amount. Used by audits and tests. */
export function containsMoneyLike(value: string): boolean {
  const probe = (pattern: RegExp) => {
    pattern.lastIndex = 0;
    return pattern.test(value);
  };
  return MONEY_PATTERNS.some(probe) || probe(PRICE_KEYWORD_PATTERN);
}

/**
 * Parse the numeric value of a price string such as "$360m", "£450 Million", "42,000,000 Pounds"
 * or "1.400,000 Euros". Returns null when no amount can be read (e.g. "Price on Request").
 * Used only to double-check that the stored asking price does not survive in public output.
 */
export function parseAmount(text: string): number | null {
  const match = /(\d(?:[\d.,]*\d)?)(?:\s?(million|billion|thousand|mn|bn|m|k)\b)?/i.exec(text);
  if (!match) return null;
  const raw = match[1] ?? '';
  const suffix = (match[2] ?? '').toLowerCase();
  // Treat "." and "," as grouping separators when they appear in groups of three, else as a decimal point.
  const grouped = /^\d{1,3}(?:[.,]\d{3})+(?:[.,]\d{1,2})?$/.test(raw);
  let normalised: string;
  if (grouped) {
    const parts = raw.split(/[.,]/);
    const last = parts[parts.length - 1] ?? '';
    normalised =
      last.length === 3 ? parts.join('') : `${parts.slice(0, -1).join('')}.${last}`;
  } else {
    normalised = raw.replace(',', '.');
  }
  const base = Number.parseFloat(normalised);
  if (!Number.isFinite(base)) return null;
  const factor =
    suffix === 'million' || suffix === 'mn' || suffix === 'm'
      ? 1e6
      : suffix === 'billion' || suffix === 'bn'
        ? 1e9
        : suffix === 'thousand' || suffix === 'k'
          ? 1e3
          : 1;
  return base * factor;
}
