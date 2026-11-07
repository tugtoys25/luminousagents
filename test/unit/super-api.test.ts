import { env, SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { hmacSha256Hex, sha256Hex } from '../../src/super-api/crypto';
import { verifySuperRequest } from '../../src/super-api/auth';
import { withInlineQueue } from '../../src/operations/inline-queue';

const BASE = 'https://mayfair.test';
const CRED = 'test-credential';
const SECRET = 'test-super-secret-0123456789abcdef';
let counter = 0;

interface Opts { nonce?: string; timestamp?: number; secret?: string; credential?: string; unsigned?: boolean }
async function call(method: string, path: string, body?: unknown, opts: Opts = {}): Promise<Response> {
  const text = body === undefined ? '' : JSON.stringify(body);
  const timestamp = String(opts.timestamp ?? Date.now());
  const nonce = opts.nonce ?? `nonce-${Date.now()}-${++counter}`;
  const canonical = [method, path, timestamp, nonce, await sha256Hex(text)].join('\n');
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (!opts.unsigned) {
    headers['Authorization'] = `Bearer ${opts.credential ?? CRED}`;
    headers['X-Lummet-Timestamp'] = timestamp;
    headers['X-Lummet-Nonce'] = nonce;
    headers['X-Lummet-Signature'] = await hmacSha256Hex(opts.secret ?? SECRET, canonical);
  }
  return SELF.fetch(`${BASE}${path}`, { method, headers, ...(text ? { body: text } : {}) });
}
const pushed = async (payload: Record<string, unknown>, secret = SECRET) => ({ payload, signature: await hmacSha256Hex(secret, JSON.stringify(payload)) });
const access = (state: string, generation: number, extra: Record<string, unknown> = {}) => ({ state, generation, siteId: 's1', issuedAt: Date.now(), ...extra });
const limit = (maxBytes: number | null, generation: number, extra: Record<string, unknown> = {}) => ({ purpose: 'storage_limit', maxBytes, generation, siteId: 's1', issuedAt: Date.now(), ...extra });
const json = async (r: Response) => (await r.json()) as Record<string, unknown>;

describe('Super API authentication', () => {
  it('answers a signed handshake, health and capabilities, and refuses everything else with one generic answer', async () => {
    const hs = await call('GET', '/en/api/super/handshake');
    expect(hs.status).toBe(200);
    expect(hs.headers.get('cache-control')).toBe('no-store');
    expect(await json(hs)).toMatchObject({ success: true, platform: 'luminousagents-brokerage', api_version: 1 });
    expect((await json(await call('GET', '/en/api/super/health')))['status']).toBe('online');
    const caps = (await json(await call('GET', '/en/api/super/capabilities')))['capabilities'] as Record<string, boolean>;
    expect(caps['storage_usage']).toBe(true);

    for (const [name, opts] of [
      ['unsigned', { unsigned: true }],
      ['wrong secret', { secret: 'x'.repeat(32) }],
      ['wrong credential', { credential: 'someone-else' }],
      ['stale timestamp', { timestamp: Date.now() - 10 * 60_000 }],
    ] as [string, Opts][]) {
      const r = await call('GET', '/en/api/super/handshake', undefined, opts);
      expect(r.status, name).toBe(401);
      expect(await json(r), name).toEqual({ success: false, error: 'unauthorized' });
    }
    const first = await call('GET', '/en/api/super/health', undefined, { nonce: 'fixed-nonce-1' });
    const replay = await call('GET', '/en/api/super/health', undefined, { nonce: 'fixed-nonce-1' });
    expect([first.status, replay.status]).toEqual([200, 401]);
  });

  it('is not configured (503) without a credential and secret', async () => {
    const bare = { ...env, SUPER_API_SECRET: undefined } as unknown as typeof env;
    const result = await verifySuperRequest(new Request(`${BASE}/en/api/super/handshake`), bare, '/en/api/super/handshake', '');
    expect(result).toMatchObject({ ok: false, status: 503 });
  });

  it('is never reachable through the cached or browser surfaces', async () => {
    const post = await SELF.fetch(`${BASE}/en/api/super/storage-limit`, { method: 'POST' });
    expect([401, 404, 405]).toContain(post.status);
  });
});

describe('site access state', () => {
  it('suspends, resumes and ignores older pushes, while health and the Super API stay reachable', async () => {
    expect((await SELF.fetch(`${BASE}/`, { headers: { accept: 'text/html' } })).status).not.toBe(503);

    const suspend = await call('PUT', '/en/api/super/site-access-state', await pushed(access('suspended', 5)));
    expect(await json(suspend)).toMatchObject({ success: true, accepted: true, generation: 5 });
    const page = await SELF.fetch(`${BASE}/`, { headers: { accept: 'text/html' } });
    expect(page.status).toBe(503);
    expect(page.headers.get('retry-after')).toBe('3600');
    expect(await page.text()).toContain('temporarily unavailable');
    expect((await SELF.fetch(`${BASE}/api/buyer/anything`)).status).toBe(503);
    expect((await SELF.fetch(`${BASE}/healthz`)).status).toBe(200);
    expect((await call('GET', '/en/api/super/health')).status).toBe(200);

    expect(await json(await call('PUT', '/en/api/super/site-access-state', await pushed(access('serving', 4))))).toMatchObject({ accepted: false, reason: 'stale_generation' });
    expect((await SELF.fetch(`${BASE}/`, { headers: { accept: 'text/html' } })).status).toBe(503);

    expect((await call('PUT', '/en/api/super/site-access-state', await pushed(access('closed', 6)))).status).toBe(200);
    expect((await SELF.fetch(`${BASE}/`, { headers: { accept: 'text/html' } })).status).toBe(410);

    expect(await json(await call('PUT', '/en/api/super/site-access-state', await pushed(access('serving', 7))))).toMatchObject({ accepted: true });
    expect((await SELF.fetch(`${BASE}/healthz`)).status).toBe(200);
    expect((await SELF.fetch(`${BASE}/`, { headers: { accept: 'text/html' } })).status).not.toBe(503);
  });

  it('rejects a bad signature, a stale push and an invalid state', async () => {
    expect((await call('PUT', '/en/api/super/site-access-state', await pushed(access('suspended', 9), 'y'.repeat(32)))).status).toBe(401);
    expect((await call('PUT', '/en/api/super/site-access-state', await pushed(access('suspended', 9, { issuedAt: Date.now() - 2 * 86_400_000 })))).status).toBe(422);
    expect((await call('PUT', '/en/api/super/site-access-state', await pushed(access('exploded', 9)))).status).toBe(422);
    expect((await call('PUT', '/en/api/super/site-access-state', await pushed(access('suspended', 0)))).status).toBe(422);
    expect((await SELF.fetch(`${BASE}/`, { headers: { accept: 'text/html' } })).status).not.toBe(503);
  });
});

describe('storage limit and usage', () => {
  it('stores the cap by generation, reports usage, and refuses uploads past the cap', async () => {
    const usage0 = await json(await call('GET', '/en/api/super/storage-usage'));
    expect(usage0).toMatchObject({ success: true, usedBytes: 0, limitBytes: null, limitGeneration: 0 });

    expect(await json(await call('PUT', '/en/api/super/storage-limit', await pushed(limit(10, 3))))).toMatchObject({ accepted: true, generation: 3 });
    expect(await json(await call('PUT', '/en/api/super/storage-limit', await pushed(limit(99, 3))))).toMatchObject({ accepted: false, reason: 'already_applied' });
    expect(await json(await call('PUT', '/en/api/super/storage-limit', await pushed(limit(99, 2))))).toMatchObject({ accepted: false, reason: 'stale_generation' });
    expect(await json(await call('GET', '/en/api/super/storage-usage'))).toMatchObject({ limitBytes: 10, limitGeneration: 3 });

    // A hand-built multipart body with an explicit Content-Length: the gate sizes uploads from that header, as browsers send it.
    const boundary = '----supertest';
    const body = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="big.png"\r\nContent-Type: image/png\r\n\r\n${'x'.repeat(4096)}\r\n--${boundary}--\r\n`;
    const upload = () =>
      SELF.fetch(`${BASE}/dashboard/media/upload`, {
        method: 'POST',
        headers: { 'content-type': `multipart/form-data; boundary=${boundary}`, 'content-length': String(body.length) },
        body,
      });
    const blocked = await upload();
    expect(blocked.status).toBe(413);
    expect(await json(blocked)).toMatchObject({ error: { code: 'STORAGE_LIMIT_REACHED' } });
    const jsonPost = await SELF.fetch(`${BASE}/dashboard/tasks`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"a":1}' });
    expect(jsonPost.status).not.toBe(413);

    expect(await json(await call('PUT', '/en/api/super/storage-limit', await pushed(limit(null, 4))))).toMatchObject({ accepted: true });
    expect((await upload()).status).not.toBe(413);
  });

  it('rejects an invalid or badly signed cap', async () => {
    for (const p of [limit(-1, 1), limit(1.5, 1), limit(1, 0), limit(1, 1, { purpose: 'other' }), limit(1, 1, { issuedAt: Date.now() - 2 * 86_400_000 })]) {
      expect([422]).toContain((await call('PUT', '/en/api/super/storage-limit', await pushed(p))).status);
    }
    expect((await call('PUT', '/en/api/super/storage-limit', await pushed(limit(1, 1), 'z'.repeat(32)))).status).toBe(401);
  });
});

describe('inline notification queue', () => {
  it('leaves a real queue binding alone and otherwise delivers through waitUntil', async () => {
    const waiting: Promise<unknown>[] = [];
    const ctx = { waitUntil: (p: Promise<unknown>) => void waiting.push(p), passThroughOnException: () => undefined } as unknown as ExecutionContext;
    expect(withInlineQueue(env, ctx)).toBe(env);

    const noQueue = withInlineQueue({ ...env, NOTIFICATIONS_QUEUE: undefined } as unknown as typeof env, ctx);
    expect(noQueue.NOTIFICATIONS_QUEUE).toBeDefined();
    await noQueue.NOTIFICATIONS_QUEUE.send({ jobId: 'does-not-exist', type: 'x' } as never);
    await noQueue.NOTIFICATIONS_QUEUE.sendBatch([{ body: {} } as never]);
    expect(waiting).toHaveLength(2);
    await expect(Promise.all(waiting)).resolves.toBeDefined();
  });
});
