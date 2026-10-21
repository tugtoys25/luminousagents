import type { Env } from '../env';
import { applyOverrides, policyFromEnv, type SellerPolicy, type Source } from './policy';
import { listPolicyRows } from './policy-repo';

/** One small read per use. If the table cannot be read, the environment view applies (safe defaults), never an open policy. */
export async function loadSellerPolicy(env: Env): Promise<SellerPolicy> {
  return (await loadSellerPolicyDetail(env)).policy;
}
export async function loadSellerPolicyDetail(env: Env): Promise<{ policy: SellerPolicy; sources: Record<string, Source>; rows: Awaited<ReturnType<typeof listPolicyRows>> }> {
  const base = policyFromEnv(env as unknown as Record<string, string | undefined>);
  try {
    const rows = await listPolicyRows(env.DB);
    return { ...applyOverrides(base, rows, env as unknown as Record<string, string | undefined>), rows };
  } catch {
    return { ...applyOverrides(base, [], env as unknown as Record<string, string | undefined>), rows: [] };
  }
}
