import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../../src/env';
import { scanR2Document } from '../../src/security/malware-scanner';

const bytes = new TextEncoder().encode('%PDF-1.7 test data');
const hex = (value: Uint8Array) =>
  Array.from(value, (b) => b.toString(16).padStart(2, '0')).join('');
const digest = async (value: Uint8Array) =>
  hex(new Uint8Array(await crypto.subtle.digest('SHA-256', value)));
const secret = 'test-secret-signing-key-long-enough';
async function signedResponse(
  verdict: 'clean' | 'malicious' | 'unsupported' = 'clean',
  override: Record<string, unknown> = {},
) {
  const sha256 = await digest(bytes);
  const result = {
    provider: 'test-av',
    reference: 'scan-123',
    status: 'completed',
    verdict,
    sha256,
    scannedAt: '2026-10-09T10:00:00.000Z',
    engineVersion: 'engine-1',
    ...override,
  } as Record<string, string>;
  const canonical = `${result.reference}\n${String(result.sha256).toLowerCase()}\n${result.status}\n${result.verdict}\n${result.engineVersion}\n${result.scannedAt}`;
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  result.signatureHex = hex(
    new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(canonical))),
  );
  return result;
}
function envFor(response: unknown, stored = bytes) {
  return {
    MALWARE_SCANNER_API_URL: 'https://scanner.example.test',
    MALWARE_SCANNER_API_TOKEN: 'token',
    MALWARE_SCANNER_SIGNING_SECRET: secret,
    MALWARE_SCANNER_PROVIDER: 'test-av',
    PRIVATE_FILES: {
      get: vi.fn(async () => ({
        arrayBuffer: async () =>
          stored.buffer.slice(stored.byteOffset, stored.byteOffset + stored.byteLength),
      })),
    },
  } as unknown as Env;
}
const input = async (stored = bytes) => ({
  documentId: 'doc-1',
  r2Key: 'private/doc-1',
  contentType: 'application/pdf',
  expectedSha256: await digest(stored),
});
afterEach(() => vi.unstubAllGlobals());

describe('signed R2 malware scanner adapter', () => {
  it('scans exact object bytes and accepts an authenticated clean verdict', async () => {
    const result = await signedResponse();
    const env = envFor(result);
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        expect(init.body).toBeInstanceOf(ArrayBuffer);
        expect(init.headers).toMatchObject({ 'X-Content-SHA256': result.sha256 });
        return Response.json(result);
      }),
    );
    await expect(scanR2Document(env, await input())).resolves.toMatchObject({
      verdict: 'clean',
      sha256: result.sha256,
      reference: 'scan-123',
    });
  });
  it('returns a signed malicious verdict for the caller to reject', async () => {
    const result = await signedResponse('malicious');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json(result)),
    );
    await expect(scanR2Document(envFor(result), await input())).resolves.toMatchObject({
      verdict: 'malicious',
    });
  });
  it('preserves unsupported as a verified non-clean verdict', async () => {
    const result = await signedResponse('unsupported');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json(result)),
    );
    await expect(scanR2Document(envFor(result), await input())).resolves.toMatchObject({
      verdict: 'unsupported',
    });
  });
  it('fails closed when scanner configuration is missing', async () => {
    const env = envFor({});
    delete (env as unknown as Record<string, unknown>).MALWARE_SCANNER_SIGNING_SECRET;
    await expect(scanR2Document(env, await input())).rejects.toMatchObject({
      code: 'NOT_CONFIGURED',
    });
  });
  it('detects changed R2 bytes before calling the provider', async () => {
    const env = envFor({}, new TextEncoder().encode('%PDF-changed'));
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    await expect(scanR2Document(env, await input())).rejects.toMatchObject({
      code: 'OBJECT_CHANGED',
    });
    expect(fetch).not.toHaveBeenCalled();
  });
  it('rejects a bad HMAC signature', async () => {
    const result = await signedResponse();
    result.signatureHex = '00'.repeat(32);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json(result)),
    );
    await expect(scanR2Document(envFor(result), await input())).rejects.toMatchObject({
      code: 'BAD_SIGNATURE',
    });
  });
  it('rejects a mismatched digest in provider result', async () => {
    const result = await signedResponse();
    result.sha256 = '0'.repeat(64);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json(result)),
    );
    await expect(scanR2Document(envFor(result), await input())).rejects.toMatchObject({
      code: 'INVALID_RESULT',
    });
  });
  it('fails closed when the R2 object is deleted', async () => {
    const env = envFor({});
    (env.PRIVATE_FILES as unknown as { get: ReturnType<typeof vi.fn> }).get = vi.fn(
      async () => null,
    );
    await expect(scanR2Document(env, await input())).rejects.toMatchObject({
      code: 'OBJECT_MISSING',
    });
  });
  it('fails closed when the provider request times out', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('timeout');
      }),
    );
    await expect(scanR2Document(envFor({}), await input())).rejects.toMatchObject({
      code: 'UNAVAILABLE',
    });
  });
  it('fails closed on provider error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('provider down', { status: 503 })),
    );
    await expect(scanR2Document(envFor({}), await input())).rejects.toMatchObject({
      code: 'UNAVAILABLE',
    });
  });
});
