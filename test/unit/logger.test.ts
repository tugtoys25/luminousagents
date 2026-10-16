import { describe, expect, it } from 'vitest';
import { createLogger, scrub, scrubString } from '../../src/lib/logger';

function capture(minLevel: 'debug' | 'info' | 'warn' | 'error' = 'info') {
  const lines: string[] = [];
  const push = (l: string) => lines.push(l);
  const log = createLogger({ minLevel, base: { service: 'mayfair' }, sink: { debug: push, info: push, warn: push, error: push } });
  return { lines, log };
}

describe('logger', () => {
  it('emits one JSON line with level, event, timestamp and base fields', () => {
    const { lines, log } = capture();
    log.info('hello', { requestId: 'r1', status: 200 });
    const row = JSON.parse(lines[0]!);
    expect(row).toMatchObject({ level: 'info', event: 'hello', service: 'mayfair', requestId: 'r1', status: 200 });
    expect(typeof row.ts).toBe('string');
  });
  it('respects the minimum level', () => {
    const { lines, log } = capture('warn');
    log.debug('a');
    log.info('b');
    log.warn('c');
    log.error('d');
    expect(lines).toHaveLength(2);
  });
  it('redacts sensitive keys and secret-looking strings', () => {
    const { lines, log } = capture();
    log.error('x', {
      password: 'hunter2',
      email: 'a@b.com',
      detail: 'failed for user@example.com with Bearer abcdefghijklmnop',
      nested: { apiKey: 'k', ok: 'fine' },
    });
    const text = lines[0]!;
    expect(text).not.toContain('hunter2');
    expect(text).not.toContain('user@example.com');
    expect(text).not.toContain('abcdefghijklmnop');
    expect(text).toContain('fine');
  });
  it('drops error messages, keeping only the name', () => {
    expect(scrub(new TypeError('secret detail'))).toEqual({ name: 'TypeError' });
  });
  it('truncates long strings and deep objects', () => {
    expect(scrubString('x '.repeat(500)).length).toBeLessThanOrEqual(300);
    const deep = { a: { b: { c: { d: { e: 1 } } } } };
    expect(JSON.stringify(scrub(deep))).toContain('[truncated]');
  });
  it('never throws on circular input', () => {
    const { log } = capture();
    const a: Record<string, unknown> = {};
    a.self = a;
    expect(() => log.info('c', a)).not.toThrow();
  });
});
