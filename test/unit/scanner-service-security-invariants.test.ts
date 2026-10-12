import { createServer as createTcpServer, type Server as TcpServer, type Socket } from 'node:net';
import type { AddressInfo } from 'node:net';
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Env } from '../../src/env';
import { scanR2Document } from '../../src/security/malware-scanner';
import { createScannerServer } from '../../scanner-service/server.mjs';

const TOKEN = 'test-token-0123456789-abcdefgh';
const SECRET = 'test-signing-secret-0123456789-xyz';
const EICAR = 'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*';

/** Minimal stand-in for ClamAV's clamd: understands PING, VERSION and INSTREAM. */
function fakeClamd(): TcpServer {
  return createTcpServer((socket: Socket) => {
    let buffer = Buffer.alloc(0);
    let command: string | null = null;
    const body: Buffer[] = [];
    socket.on('data', (data) => {
      buffer = Buffer.concat([buffer, data]);
      if (command === null) {
        const end = buffer.indexOf(0);
        if (end < 0) return;
        command = buffer.subarray(0, end).toString().replace(/^z/, '');
        buffer = buffer.subarray(end + 1);
        if (command === 'PING') return void socket.end('PONG\0');
        if (command === 'VERSION') return void socket.end('ClamAV 1.0.0-test/1/Mon\0');
      }
      while (command === 'INSTREAM' && buffer.length >= 4) {
        const length = buffer.readUInt32BE(0);
        if (length === 0) {
          const infected = Buffer.concat(body).toString('latin1').includes('EICAR-STANDARD-ANTIVIRUS-TEST-FILE');
          return void socket.end(infected ? 'stream: Eicar-Test-Signature FOUND\0' : 'stream: OK\0');
        }
        if (buffer.length < 4 + length) return;
        body.push(buffer.subarray(4, 4 + length));
        buffer = buffer.subarray(4 + length);
      }
    });
    socket.on('error', () => {});
  });
}

const listen = (server: TcpServer | ReturnType<typeof createScannerServer>) =>
  new Promise<number>((resolve) => server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port)));

describe('scanner service contract', () => {
  const clamd = fakeClamd();
  let service: ReturnType<typeof createScannerServer>;
  const files = new Map<string, Uint8Array>();
  let baseUrl = '';
  let clamdPort = 0;

  const envFor = (overrides: Partial<Record<string, string>> = {}) =>
    ({
      MALWARE_SCANNER_API_URL: baseUrl,
      MALWARE_SCANNER_API_TOKEN: TOKEN,
      MALWARE_SCANNER_SIGNING_SECRET: SECRET,
      MALWARE_SCANNER_PROVIDER: 'clamav-selfhosted',
      PRIVATE_FILES: {
        get: async (key: string) => {
          const bytes = files.get(key);
          return bytes ? { arrayBuffer: async () => bytes.slice().buffer } : null;
        },
      },
      ...overrides,
    }) as unknown as Env;

  const scan = (key: string, overrides?: Partial<Record<string, string>>) => {
    const bytes = files.get(key)!;
    return scanR2Document(envFor(overrides), {
      documentId: `doc-${key}`,
      r2Key: key,
      contentType: 'application/pdf',
      expectedSha256: createHash('sha256').update(bytes).digest('hex'),
    });
  };
  const codeOf = async (run: Promise<unknown>) => {
    try {
      await run;
      return 'no error';
    } catch (error) {
      return (error as { code?: string }).code ?? 'unknown';
    }
  };

  beforeAll(async () => {
    clamdPort = await listen(clamd);
    service = createScannerServer({ token: TOKEN, signingSecret: SECRET, clamdPort });
    baseUrl = `http://127.0.0.1:${await listen(service)}`;
    files.set('clean.pdf', new TextEncoder().encode('%PDF-1.4 harmless'));
    files.set('bad.pdf', new TextEncoder().encode(`%PDF-1.4 ${EICAR}`));
  });
  afterAll(() => {
    service.close();
    clamd.close();
  });

  it('returns a signed clean verdict that the Worker accepts', async () => {
    const result = await scan('clean.pdf');
    expect(result.verdict).toBe('clean');
    expect(result.provider).toBe('clamav-selfhosted');
    expect(result.engineVersion).toBe('ClamAV 1.0.0-test/1/Mon');
  });

  it('flags a malicious file', async () => {
    expect((await scan('bad.pdf')).verdict).toBe('malicious');
  });

  it('fails closed on a wrong token, a wrong signing secret, or an unreachable ClamAV', async () => {
    expect(await codeOf(scan('clean.pdf', { MALWARE_SCANNER_API_TOKEN: 'x'.repeat(30) }))).toBe('UNAVAILABLE');
    expect(await codeOf(scan('clean.pdf', { MALWARE_SCANNER_SIGNING_SECRET: 'y'.repeat(30) }))).toBe('BAD_SIGNATURE');
    clamd.close();
    expect(await codeOf(scan('clean.pdf'))).toBe('UNAVAILABLE');
  });
});
