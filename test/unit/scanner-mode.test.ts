import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../../src/env';
import {
  getScannerMode,
  scanR2Document,
  SCAN_SKIPPED_PROVIDER,
} from '../../src/security/malware-scanner';

const bytes = new TextEncoder().encode('%PDF-1.7 scanner mode test');
const digest = async (value: Uint8Array) =>
  Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', value)), (b) =>
    b.toString(16).padStart(2, '0'),
  ).join('');

function envWith(setting: string | null | 'db-error', stored: Uint8Array | null = bytes) {
  return {
    DB: {
      prepare: () => ({
        bind: () => ({
          first: async () => {
            if (setting === 'db-error') throw new Error('d1 unavailable');
            return setting === null ? null : { value: setting };
          },
        }),
      }),
    },
    PRIVATE_FILES: {
      get: vi.fn(async () =>
        stored
          ? {
              arrayBuffer: async () =>
                stored.buffer.slice(stored.byteOffset, stored.byteOffset + stored.byteLength),
            }
          : null,
      ),
    },
  } as unknown as Env;
}
const input = async () => ({
  documentId: 'doc-1',
  r2Key: 'private/doc-1',
  contentType: 'application/pdf',
  expectedSha256: await digest(bytes),
});

afterEach(() => vi.unstubAllGlobals());

describe('admin scanner switch', () => {
  it('releases a file as scan-disabled without calling the scanner when switched off', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const result = await scanR2Document(envWith('"disabled"'), await input());
    expect(result).toMatchObject({
      provider: SCAN_SKIPPED_PROVIDER,
      verdict: 'clean',
      status: 'completed',
      engineVersion: 'scanner-disabled',
    });
    expect(result.reference).toMatch(/^skipped-/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('still refuses a missing or changed stored object while switched off', async () => {
    await expect(scanR2Document(envWith('"disabled"', null), await input())).rejects.toMatchObject({
      code: 'OBJECT_MISSING',
    });
    await expect(
      scanR2Document(envWith('"disabled"', new TextEncoder().encode('%PDF-other')), await input()),
    ).rejects.toMatchObject({ code: 'OBJECT_CHANGED' });
  });

  it('fails closed to enforced mode for missing, odd or unreadable settings', async () => {
    for (const setting of [null, '"enforced"', '"off"', 'true', 'not json', 'db-error'] as const) {
      expect(await getScannerMode(envWith(setting))).toBe('enforced');
      await expect(scanR2Document(envWith(setting), await input())).rejects.toMatchObject({
        code: 'NOT_CONFIGURED',
      });
    }
  });
});
