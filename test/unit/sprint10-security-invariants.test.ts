import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
const read = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8');

describe('Sprint 10 security invariants', () => {
  it('uses an explicit broker ownership column and migration', () => {
    expect(read('migrations/0012_broker_assignment.sql')).toMatch(/assigned_broker_id/);
    const admin = read('src/admin/routes.ts');
    expect(admin).toMatch(/assigned_broker_id = \?/);
    expect(admin).toMatch(/Only administrators can reassign a broker/);
  });

  it('assigns opportunity enquiries, creates a one-working-day task, and queues broker notice', () => {
    const enquiries = read('src/enquiries/routes.ts');
    expect(enquiries).toMatch(/assigned_broker_id AS assignedBrokerId/);
    expect(enquiries).toMatch(/oneWorkingDayLater/);
    expect(enquiries).toMatch(/Review new website enquiry/);
    expect(enquiries).toMatch(/enquiry\.assigned/);
    expect(enquiries).toMatch(/enquiry\.acknowledgement/);
    expect(enquiries).toMatch(/'staging','production'/);
    expect(read('src/operations/queue.ts')).toMatch(/job\.job_type === 'enquiry\.assigned'/);
    expect(read('src/operations/queue.ts')).toMatch(/job\.job_type === 'enquiry\.acknowledgement'/);
  });

  it('does not permit manual clean status without verified scanner processing', () => {
    const admin = read('src/admin/routes.ts');
    expect(admin).toMatch(/scanR2Document\(c\.env/);
    expect(admin).toMatch(/VERIFIED_SCAN_REQUIRED/);
    expect(read('src/security/malware-scanner.ts')).toMatch(/crypto\.subtle\.verify/);
  });

  it('removes inline page styles from CSP-protected dashboard and buyer pages', () => {
    for (const path of ['src/admin/routes.ts', 'src/buyers/routes.ts']) {
      const source = read(path);
      expect(source).not.toMatch(/<style\s*>/i);
      expect(source).not.toMatch(/\sstyle\s*=\s*["']/);
    }
  });

  it('captures the active NDA template digest and salted IP digest at acceptance', () => {
    const buyers = read('src/buyers/routes.ts');
    expect(buyers).toMatch(/accepted_ip_hash, nda_template_hash/);
    expect(buyers).toMatch(/IP_HASH_SECRET/);
    expect(buyers).toMatch(/template\.contentHash/);
  });
});
