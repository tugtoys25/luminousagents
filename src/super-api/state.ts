import type { Env } from '../env';
import { readState, usedBytes, writeState } from './super-repo';

export type AccessState = 'serving' | 'suspended' | 'closed';
const KV_KEY = 'super:site-access';
const MEMO_MS = 10_000;
let memo: { state: AccessState; until: number } | null = null;

/** Stores the pushed access state (newest generation wins) and mirrors it to KV, which the per-request gate reads. */
export async function applySiteAccess(env: Env, state: AccessState, generation: number): Promise<boolean> {
  const applied = await writeState(env.DB, 'site_access', JSON.stringify({ state }), generation, new Date().toISOString());
  if (applied) {
    memo = { state, until: Date.now() + MEMO_MS };
    await env.CACHE.put(KV_KEY, state).catch(() => undefined);
  }
  return applied;
}

/** The current access state, from a 10 second isolate memo, then KV, then D1. A read failure serves (never locks a site out). */
export async function currentAccessState(env: Env): Promise<AccessState> {
  if (memo && memo.until > Date.now()) return memo.state;
  let state: AccessState = 'serving';
  try {
    const cached = await env.CACHE.get(KV_KEY);
    if (cached === 'serving' || cached === 'suspended' || cached === 'closed') state = cached;
    else {
      const row = await readState(env.DB, 'site_access');
      const stored = row ? (JSON.parse(row.value) as { state?: string }).state : null;
      if (stored === 'suspended' || stored === 'closed') state = stored;
      await env.CACHE.put(KV_KEY, state).catch(() => undefined);
    }
  } catch {
    return 'serving';
  }
  memo = { state, until: Date.now() + MEMO_MS };
  return state;
}

export async function readLimit(db: D1Database): Promise<{ maxBytes: number | null; generation: number }> {
  const row = await readState(db, 'storage_limit');
  if (!row) return { maxBytes: null, generation: 0 };
  const parsed = JSON.parse(row.value) as { maxBytes?: number | null };
  return { maxBytes: typeof parsed.maxBytes === 'number' ? parsed.maxBytes : null, generation: row.generation };
}

/** True when adding `incoming` bytes would pass the plan's storage cap (no cap pushed: never). */
export async function wouldExceedLimit(env: Env, incoming: number): Promise<boolean> {
  if ((env.STORAGE_METERING_MODE ?? 'enforce').toLowerCase() === 'off') return false;
  const limit = await readLimit(env.DB);
  if (limit.maxBytes === null) return false;
  return (await usedBytes(env.DB)) + incoming > limit.maxBytes;
}

export function resetAccessMemoForTests(): void {
  memo = null;
}
