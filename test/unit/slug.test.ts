import { describe, expect, it } from 'vitest';
import { slugify } from '../../src/domain/opportunities/slug';

describe('slugify', () => {
  it('normalizes punctuation, ampersands and accents', () => {
    expect(slugify('Café & Casino — London!')).toBe('cafe-and-casino-london');
  });

  it('returns a safe fallback for an empty slug', () => {
    expect(slugify('---')).toBe('opportunity');
  });
});
