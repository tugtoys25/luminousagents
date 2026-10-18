import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import sellerRoutes, { sellerBodyLimit } from '../../src/seller/routes';
import { valid } from '../support/seller-fixtures';

type Stmt = { sql: string; args: unknown[] };
function harness(opts: { existing?: string | null; batchError?: Error | (() => Error | null); queueFails?: boolean; env?: Record<string, unknown> } = {}) {
  const batches: Stmt[][] = [];
  const kv = new Map<string, string>();
  const sent: unknown[] = [];
  let batchCalls = 0;
  const db = {
    prepare: (sql: string) => ({
      bind: (...args: unknown[]) => ({
        sql, args,
        first: async () => (sql.includes('idempotency_hash') && opts.existing ? { reference: opts.existing } : null),
      }),
    }),
    batch: async (stmts: Stmt[]) => {
      batchCalls++;
      const err = typeof opts.batchError === 'function' ? opts.batchError() : opts.batchError;
      if (err) throw err;
      batches.push(stmts);
    },
  };
  const env = {
    APP_ENV: 'staging', IP_HASH_SECRET: 'test-secret', DB: db,
    CACHE: { get: async (k: string) => kv.get(k) ?? null, put: async (k: string, v: string) => void kv.set(k, v) },
    NOTIFICATIONS_QUEUE: { send: async (m: unknown) => { if (opts.queueFails) throw new Error('queue down'); sent.push(m); } },
    ...opts.env,
  };
  const app = new Hono<{ Variables: { requestId: string } }>();
  app.use('*', async (c, next) => { c.set('requestId', 'req-1'); await next(); });
  app.use('/api/sell-a-casino', sellerBodyLimit);
  app.route('/', sellerRoutes as never);
  const post = (body: unknown, headers: Record<string, string> = {}, raw?: string) =>
    app.request('/api/sell-a-casino', { method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.9', ...headers }, body: raw ?? JSON.stringify(body) }, env);
  return { post, batches, sent, kv, calls: () => batchCalls };
}

describe('POST /api/sell-a-casino', () => {
  it('persists, queues both emails and returns a reference without internal ids', async () => {
    const h = harness();
    const res = await h.post(valid());
    expect(res.status).toBe(202);
    const body = (await res.json()) as { data: { reference: string } };
    expect(body.data.reference).toMatch(/^CM-S-/);
    expect(h.batches).toHaveLength(1);
    expect(h.batches[0]).toHaveLength(4);
    expect(h.sent).toHaveLength(2);
    expect(JSON.stringify(body)).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}/);
  });
  it('still accepts the enquiry when enqueue fails (durable job rows remain for recovery)', async () => {
    const h = harness({ queueFails: true });
    expect((await h.post(valid())).status).toBe(202);
    expect(h.batches).toHaveLength(1);
  });
  it('returns the same neutral success for a repeated idempotency key without inserting', async () => {
    const h = harness({ existing: 'CM-S-AAAAAA' });
    const res = await h.post(valid());
    expect(res.status).toBe(202);
    expect(((await res.json()) as { data: { reference: string } }).data.reference).toBe('CM-S-AAAAAA');
    expect(h.calls()).toBe(0);
  });
  it('retries on a reference collision with a fresh reference', async () => {
    let n = 0;
    const h = harness({ batchError: () => (n++ === 0 ? new Error('D1_ERROR: UNIQUE constraint failed: seller_enquiries.reference') : null) });
    const res = await h.post(valid());
    expect(res.status).toBe(202);
    expect(h.calls()).toBe(2);
  });
  it('returns a generic error (no details) when persistence fails', async () => {
    const h = harness({ batchError: new Error('D1_ERROR: disk exploded at table seller_enquiries') });
    const res = await h.post(valid());
    expect(res.status).toBe(500);
    expect(await res.text()).not.toMatch(/disk|seller_enquiries|stack/i);
    expect(h.sent).toHaveLength(0);
  });
  it('rejects wrong content type, malformed JSON, arrays and oversized bodies', async () => {
    const h = harness();
    expect((await h.post(valid(), { 'content-type': 'text/plain' })).status).toBe(415);
    expect((await h.post(null, {}, '{nope')).status).toBe(400);
    expect((await h.post(null, {}, '[]')).status).toBe(400);
    expect((await h.post({ ...valid(), asset_description: 'x'.repeat(40_000) })).status).toBe(413);
    expect(h.calls()).toBe(0);
  });
  it('returns field errors for invalid input and stores nothing', async () => {
    const h = harness();
    const res = await h.post({ ...valid(), email: 'bad', privacy_acknowledged: false });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: { fields: Record<string, string> } };
    expect(Object.keys(body.error.fields)).toEqual(expect.arrayContaining(['email', 'privacy_acknowledged']));
    expect(h.calls()).toBe(0);
  });
  it('rate limits per pseudonymous IP', async () => {
    const h = harness();
    for (let i = 0; i < 5; i++) await h.post({ ...valid(), idempotency_key: `abcdefghijklmnop${i}000` });
    expect((await h.post({ ...valid(), idempotency_key: 'zzzzzzzzzzzzzzzz9999' })).status).toBe(429);
    expect([...h.kv.keys()].every((k) => !k.includes('203.0.113.9'))).toBe(true);
  });
  it('honeypot looks successful but stores nothing', async () => {
    const h = harness();
    expect((await h.post({ ...valid(), website: 'http://spam' })).status).toBe(202);
    expect(h.calls()).toBe(0);
  });
  it('fails closed when the hash secret is missing outside dev', async () => {
    const h = harness({ env: { IP_HASH_SECRET: undefined } });
    expect((await h.post(valid())).status).toBe(503);
  });
  it('never records marketing consent unless explicitly enabled', async () => {
    const h = harness();
    await h.post({ ...valid(), marketing_consent: true });
    const insert = h.batches[0]![0]!;
    expect(insert.args).not.toContain('seller-form-marketing-v1');
  });
});
