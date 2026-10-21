/** Removes evidence bytes that were marked for deletion. Idempotent: deleting an absent object is fine, and the DB row is only marked purged afterwards. */
import type { Env } from '../env';
import { listPurgePending, markPurged } from './evidence-repo';

export async function runEvidencePurge(env: Env, limit = 50): Promise<{ purged: number; failed: number }> {
  let purged = 0;
  let failed = 0;
  for (const item of await listPurgePending(env.DB, limit)) {
    try {
      await env.PRIVATE_FILES.delete(item.r2Key);
      if (await markPurged(env.DB, { evidenceId: item.id, logId: crypto.randomUUID(), ts: new Date().toISOString() })) purged++;
    } catch {
      failed++; // stays pending; the next scheduled run retries it
    }
  }
  return { purged, failed };
}
