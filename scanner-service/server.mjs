#!/usr/bin/env node
/*
 * Mayfair malware-scanner service (free, self-hosted, no dependencies).
 *
 * Implements the contract in src/security/malware-scanner.ts:
 *   POST /v1/scans  (raw file bytes, Bearer token, X-Content-SHA256)
 *   -> signed JSON verdict (HMAC-SHA256 with SCANNER_SIGNING_SECRET)
 * The actual virus scanning is done by ClamAV's clamd daemon over TCP.
 *
 * Environment: SCANNER_TOKEN, SCANNER_SIGNING_SECRET (both 24+ characters),
 * optional SCANNER_PROVIDER, PORT, CLAMD_HOST, CLAMD_PORT.
 */
import http from 'node:http';
import net from 'node:net';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';

const CHUNK = 64 * 1024;

function clamd(host, port, command, body) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host, port });
    const parts = [];
    socket.setTimeout(15_000, () => socket.destroy(new Error('clamd timeout')));
    socket.on('error', reject);
    socket.on('data', (data) => parts.push(data));
    socket.on('close', () =>
      resolve(Buffer.concat(parts).toString('utf8').replaceAll('\0', '').trim()),
    );
    socket.on('connect', () => {
      socket.write(`z${command}\0`);
      if (body) {
        for (let offset = 0; offset < body.length; offset += CHUNK) {
          const part = body.subarray(offset, Math.min(offset + CHUNK, body.length));
          const length = Buffer.alloc(4);
          length.writeUInt32BE(part.length);
          socket.write(length);
          socket.write(part);
        }
        socket.write(Buffer.alloc(4));
      }
    });
  });
}

function verdictFrom(reply) {
  if (/\sOK$/.test(reply)) return 'clean';
  if (/\sFOUND$/.test(reply)) return 'malicious';
  throw new Error(`clamd: ${reply || 'no reply'}`);
}

function readBody(req, max) {
  return new Promise((resolve, reject) => {
    const parts = [];
    let size = 0;
    let tooLarge = false;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > max) tooLarge = true;
      else parts.push(chunk);
    });
    req.on('end', () =>
      tooLarge ? reject(Object.assign(new Error('too large'), { status: 413 })) : resolve(Buffer.concat(parts)),
    );
    req.on('error', reject);
  });
}

export function createScannerServer(config) {
  const {
    token,
    signingSecret,
    provider = 'clamav-selfhosted',
    clamdHost = '127.0.0.1',
    clamdPort = 3310,
    maxBytes = 25 * 1024 * 1024,
    log = () => {},
  } = config;
  const expectedAuth = Buffer.from(`Bearer ${token}`);
  const authorised = (header) => {
    const given = Buffer.from(header || '');
    return given.length === expectedAuth.length && crypto.timingSafeEqual(given, expectedAuth);
  };
  const send = (res, status, payload) => {
    const text = JSON.stringify(payload);
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(text);
  };

  return http.createServer(async (req, res) => {
    try {
      const path = (req.url || '').split('?')[0];
      if (req.method === 'GET' && path === '/health') {
        await clamd(clamdHost, clamdPort, 'PING').then((r) => {
          if (r !== 'PONG') throw new Error('no pong');
        });
        return send(res, 200, { ok: true });
      }
      if (req.method !== 'POST' || path !== '/v1/scans') return send(res, 404, { error: 'not_found' });
      if (!authorised(req.headers.authorization)) return send(res, 401, { error: 'unauthorised' });

      const bytes = await readBody(req, maxBytes);
      const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
      const claimed = String(req.headers['x-content-sha256'] || '').toLowerCase();
      if (claimed && claimed !== sha256) return send(res, 422, { error: 'digest_mismatch' });

      const reply = await clamd(clamdHost, clamdPort, 'INSTREAM', bytes);
      const verdict = verdictFrom(reply);
      const engineVersion = (await clamd(clamdHost, clamdPort, 'VERSION')) || 'clamav';
      const reference = crypto.randomUUID();
      const scannedAt = new Date().toISOString();
      const status = 'completed';
      const canonical = `${reference}\n${sha256}\n${status}\n${verdict}\n${engineVersion}\n${scannedAt}`;
      const signatureHex = crypto.createHmac('sha256', signingSecret).update(canonical).digest('hex');
      log(`scan ${req.headers['x-document-id'] || '-'} ${verdict} ${bytes.length}B`);
      return send(res, 200, { provider, reference, status, verdict, sha256, scannedAt, engineVersion, signatureHex });
    } catch (error) {
      if (error && error.status === 413) return send(res, 413, { error: 'too_large' });
      log(`error ${error instanceof Error ? error.message : 'unknown'}`);
      return send(res, 503, { error: 'scanner_unavailable' });
    }
  });
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const token = process.env.SCANNER_TOKEN || '';
  const signingSecret = process.env.SCANNER_SIGNING_SECRET || '';
  if (token.length < 24 || signingSecret.length < 24) {
    console.error('Set SCANNER_TOKEN and SCANNER_SIGNING_SECRET (24+ characters each). Use start.sh to create them.');
    process.exit(1);
  }
  const server = createScannerServer({
    token,
    signingSecret,
    provider: process.env.SCANNER_PROVIDER || 'clamav-selfhosted',
    clamdHost: process.env.CLAMD_HOST || '127.0.0.1',
    clamdPort: Number(process.env.CLAMD_PORT || 3310),
    log: (line) => console.log(`${new Date().toISOString()} ${line}`),
  });
  const port = Number(process.env.PORT || 8787);
  server.listen(port, '127.0.0.1', () => console.log(`Scanner listening on http://127.0.0.1:${port}`));
}
