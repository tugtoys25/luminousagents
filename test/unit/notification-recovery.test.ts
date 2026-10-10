import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { consumeNotifications } from '../../src/operations/queue';

describe('notification retry and recovery', () => {
  it('requeues a notification job when its handler fails', async () => {
    const jobId = crypto.randomUUID(); const timestamp = new Date().toISOString();
    await env.DB.prepare("INSERT INTO notification_jobs (id,job_type,payload_json,status,attempts,available_at,created_at,updated_at) VALUES (?,'test.unsupported',?,'queued',0,?,?,?)")
      .bind(jobId, JSON.stringify({ fixture: 'retry-only' }), timestamp, timestamp, timestamp).run();
    let acked = false; let retried: number | undefined;
    try {
      await consumeNotifications({ messages: [{ body: { jobId }, ack() { acked = true; }, retry(options: { delaySeconds?: number }) { retried = options.delaySeconds; } }] } as never, env);
      const job = await env.DB.prepare('SELECT status,attempts,available_at AS availableAt FROM notification_jobs WHERE id=?').bind(jobId).first<{status:string;attempts:number;availableAt:string}>();
      expect(acked).toBe(false);
      expect(retried).toBeGreaterThan(0);
      expect(job?.status).toBe('queued');
      expect(job?.attempts).toBe(1);
    } finally {
      await env.DB.prepare('DELETE FROM notification_jobs WHERE id=?').bind(jobId).run();
    }
  });
});
