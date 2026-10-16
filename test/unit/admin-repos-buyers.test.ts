import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import {
  activateInvitedBuyer, createActiveBuyer, findAccountByEmail, findActiveBuyerContact, findBuyer,
  findBuyerContact, listBuyers, setBuyerStatus,
} from '../../src/admin/repos/buyers-repo';

// These steps share database state and must run in order. The Workers test pool undoes storage after
// every test, so they run as steps inside one test instead of as separate `it` blocks.
async function step(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (error) {
    if (error instanceof Error) error.message = `[${name}] ${error.message}`;
    throw error;
  }
}

const ts = '2026-03-01T10:00:00.000Z';
const base = { staffId: 'br-staff', requestId: 'rq', timestamp: '2026-04-01T00:00:00.000Z' };
const user = (id: string, type: string, status: string) =>
  env.DB.prepare(
    "INSERT INTO users (id, email, display_name, role, user_type, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  ).bind(id, `${id}@example.com`, id, type === 'buyer' ? 'buyer' : 'admin', type, status, ts, ts).run();
const auditRows = (id: string) =>
  env.DB.prepare('SELECT action FROM audit_logs WHERE id = ?').bind(id).all<{ action: string }>();

describe('buyers repo', () => {
  it('runs its steps in order', async () => {
    await step('lists only buyers, invited first, and finds by type', async () => {
      await user('br-staff', 'staff', 'active');
      await user('br-active', 'buyer', 'active');
      await user('br-invited', 'buyer', 'invited');
      const rows = await listBuyers(env.DB);
      const ids = rows.map((r) => r['id']);
      expect(ids.includes('br-staff')).toBe(false);
      expect(ids.indexOf('br-invited')).toBeLessThan(ids.indexOf('br-active'));
      expect(await findBuyer(env.DB, 'br-staff')).toBeNull();
      expect((await findBuyerContact(env.DB, 'br-active'))?.email).toBe('br-active@example.com');
      expect(await findActiveBuyerContact(env.DB, 'br-invited')).toBeNull();
      expect((await findAccountByEmail(env.DB, 'BR-STAFF@EXAMPLE.COM'))?.userType).toBe('staff');
    });

    await step('suspending revokes sessions and audits; re-activating leaves sessions alone', async () => {
      await env.DB.prepare(
        "INSERT INTO sessions (id, user_id, token_hash, created_at, last_seen_at, expires_at, session_type) VALUES ('br-s1', 'br-active', 'br-h1', ?, ?, '2099-01-01T00:00:00.000Z', 'buyer')",
      ).bind(ts, ts).run();
      await setBuyerStatus(env.DB, { ...base, buyerId: 'br-active', from: 'active', to: 'active', auditId: 'br-a0' });
      let s = await env.DB.prepare("SELECT revoked_at AS r FROM sessions WHERE id='br-s1'").first<{ r: string | null }>();
      expect(s?.r).toBeNull();
      await setBuyerStatus(env.DB, { ...base, buyerId: 'br-active', from: 'active', to: 'suspended', auditId: 'br-a1' });
      s = await env.DB.prepare("SELECT revoked_at AS r FROM sessions WHERE id='br-s1'").first<{ r: string | null }>();
      expect(s?.r).toBe(base.timestamp);
      expect((await findBuyer(env.DB, 'br-active'))?.status).toBe('suspended');
      expect((await auditRows('br-a1')).results[0]?.action).toBe('buyer.status_changed');
    });

    await step('activates an invited buyer once and writes the provisioning audit only on a real change', async () => {
      const details = JSON.stringify({ email: 'x', reactivated: true });
      const ok = await activateInvitedBuyer(env.DB, { ...base, buyerId: 'br-invited', displayName: 'New Name', auditId: 'br-p1', auditDetails: details });
      expect(ok).toBe(true);
      expect((await auditRows('br-p1')).results).toHaveLength(1);
      // Already active now: the UPDATE matches nothing, so changes() is 0 and no audit row may be written.
      const again = await activateInvitedBuyer(env.DB, { ...base, buyerId: 'br-invited', displayName: 'Other', auditId: 'br-p2', auditDetails: details });
      expect(again).toBe(true);
      expect((await auditRows('br-p2')).results).toHaveLength(0);
      // A suspended account is never activated by provisioning.
      const blocked = await activateInvitedBuyer(env.DB, { ...base, buyerId: 'br-active', displayName: 'Nope', auditId: 'br-p3', auditDetails: details });
      expect(blocked).toBe(false);
      expect((await auditRows('br-p3')).results).toHaveLength(0);
    });

    await step('creates a new active buyer with its audit row', async () => {
      await createActiveBuyer(env.DB, { ...base, buyerId: 'br-new', email: 'br-new@example.com', displayName: 'Newbie', auditId: 'br-c1', auditDetails: '{}' });
      expect((await findBuyer(env.DB, 'br-new'))?.status).toBe('active');
      expect((await auditRows('br-c1')).results[0]?.action).toBe('buyer.provisioned');
      let threw = false;
      try {
        await createActiveBuyer(env.DB, { ...base, buyerId: 'br-new2', email: 'br-new@example.com', displayName: 'Dup', auditId: 'br-c2', auditDetails: '{}' });
      } catch {
        threw = true;
      }
      expect(threw).toBe(true);
      expect((await auditRows('br-c2')).results).toHaveLength(0);
    });
  });
});
