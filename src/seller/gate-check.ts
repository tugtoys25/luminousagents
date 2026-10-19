import { evaluatePublicationGates, type GateResult } from './gates';
import { loadGateInput } from './publication-repo';

/** Application-level gate check used by the publication endpoints; the database trigger is the backstop. */
export async function sellerGateResult(db: D1Database, opportunityId: string, nowIso = new Date().toISOString()): Promise<GateResult> {
  return evaluatePublicationGates(await loadGateInput(db, opportunityId), nowIso);
}
