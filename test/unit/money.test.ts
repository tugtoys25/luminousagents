import { describe, expect, it } from 'vitest';
import { formatMinor, parsePriceText, type Currency } from '../../src/lib/money';

const exact = (text: string) => {
  const r = parsePriceText(text);
  if (r.kind !== 'exact') throw new Error(`${text} -> ${JSON.stringify(r)}`);
  return r;
};

describe('parsePriceText exact cases', () => {
  it.each<[string, Currency, number]>([
    ['£450 Million', 'GBP', 45_000_000_000],
    ['$500m', 'USD', 50_000_000_000],
    ['$2m', 'USD', 200_000_000],
    ['7m Euros', 'EUR', 700_000_000],
    ['80,000,000 pounds', 'GBP', 8_000_000_000],
    ['55.000.000 Euros', 'EUR', 5_500_000_000],
    ['450.000.000 Euros', 'EUR', 45_000_000_000],
    ['7500 euros', 'EUR', 750_000],
    ['9,500 euros', 'EUR', 950_000],
    ['£225 m', 'GBP', 22_500_000_000],
    ['2 billion euros', 'EUR', 200_000_000_000],
    ['25M EUROS', 'EUR', 2_500_000_000],
    ['350m Sterling', 'GBP', 35_000_000_000],
    ['500 dollars', 'USD', 50_000],
    ['£750 million', 'GBP', 75_000_000_000],
    ['$1,000,000', 'USD', 100_000_000],
  ])('%s', (text: string, currency: Currency, minor: number) => {
    expect(exact(text)).toEqual({ kind: 'exact', currency, minor });
  });
  it('accepts a decimal multiplier', () => {
    expect(exact('£7.5m').minor).toBe(750_000_000);
  });
});

describe('parsePriceText refuses to guess', () => {
  it.each<string>(['£6.700,000', '£420,000.000', '240,000,000m Euros', '5.900,000 Euros', '1,5 million euros', '450,000', 'about a lot'])(
    '%s is ambiguous',
    (text: string) => {
      expect(parsePriceText(text).kind).toBe('ambiguous');
    },
  );
  it('classifies empty and on-request values', () => {
    expect(parsePriceText('').kind).toBe('empty');
    expect(parsePriceText(null).kind).toBe('empty');
    expect(parsePriceText('Price on Request').kind).toBe('on_request');
  });
  it('rejects conflicting currencies', () => {
    expect(parsePriceText('$5m euros').kind).toBe('ambiguous');
  });
});

describe('formatMinor', () => {
  it('formats compactly', () => {
    expect(formatMinor(45_000_000_000, 'GBP')).toBe('£450 million');
    expect(formatMinor(200_000_000_000, 'EUR')).toBe('€2 billion');
    expect(formatMinor(95_000, 'USD')).toBe('$950');
  });
});
