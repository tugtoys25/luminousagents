import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import {
  activateTemplate, createTemplateVersion, findTemplate, latestTemplateVersion, listTemplates,
} from '../../src/admin/repos/nda-templates-repo';

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
const base = { staffId: 'nt-staff', requestId: 'rq', timestamp: ts };
const t = (id: string, version: number, activate: boolean) => ({
  ...base, id, name: 'Repo NDA', version, r2Key: `nda/templates/${id}/v${version}.txt`, contentHash: `hash-${id}`, activate, auditId: `aud-${id}`,
});
const active = async () =>
  (await env.DB.prepare("SELECT id FROM nda_templates WHERE status = 'active'").all<{ id: string }>()).results.map((r) => r.id);

describe('nda templates repo', () => {
  it('runs its steps in order', async () => {
    await step('versions per name and keeps exactly one active template', async () => {
      await env.DB.prepare(
        "INSERT INTO users (id, email, display_name, role, user_type, status, created_at, updated_at) VALUES ('nt-staff', 'nt@example.com', 'N', 'admin', 'staff', 'active', ?, ?)",
      ).bind(ts, ts).run();
      expect(await latestTemplateVersion(env.DB, 'Repo NDA')).toBe(0);
      await createTemplateVersion(env.DB, t('nt-1', 1, false));
      expect(await latestTemplateVersion(env.DB, 'Repo NDA')).toBe(1);
      expect((await findTemplate(env.DB, 'nt-1'))?.status).toBe('draft');
  
      const before = await active();
      await createTemplateVersion(env.DB, t('nt-2', 2, true));
      const after = await active();
      expect(after).toEqual(['nt-2']); // creating with activate retires whatever was active
      expect(before.length <= 1).toBe(true);
      const a = await env.DB.prepare("SELECT action FROM audit_logs WHERE id='aud-nt-2'").first<{ action: string }>();
      expect(a?.action).toBe('nda.template.created');
    });

    await step('activating swaps the active template atomically and audits', async () => {
      await activateTemplate(env.DB, { ...base, templateId: 'nt-1', version: 1, contentHash: 'hash-nt-1', auditId: 'aud-act-1' });
      expect(await active()).toEqual(['nt-1']);
      expect((await findTemplate(env.DB, 'nt-2'))?.status).toBe('retired');
      // Re-activating the already active template keeps it active (retire then re-activate).
      await activateTemplate(env.DB, { ...base, templateId: 'nt-1', version: 1, contentHash: 'hash-nt-1', auditId: 'aud-act-2' });
      expect(await active()).toEqual(['nt-1']);
      const a = await env.DB.prepare("SELECT action FROM audit_logs WHERE id='aud-act-1'").first<{ action: string }>();
      expect(a?.action).toBe('nda.template.activated');
    });

    await step('lists newest versions first and returns null for unknown ids', async () => {
      const rows = await listTemplates(env.DB);
      const versions = rows.map((r) => Number(r['version']));
      expect([...versions].sort((a, b) => b - a)).toEqual(versions);
      expect(await findTemplate(env.DB, 'missing')).toBeNull();
    });

    await step('rolls back a creation whose audit row collides', async () => {
      let threw = false;
      try {
        await createTemplateVersion(env.DB, { ...t('nt-3', 3, true), auditId: 'aud-act-1' });
      } catch {
        threw = true;
      }
      expect(threw).toBe(true);
      expect(await findTemplate(env.DB, 'nt-3')).toBeNull();
      expect(await active()).toEqual(['nt-1']); // the retire step was rolled back too
    });
  });
});
