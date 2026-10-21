import { describe, expect, it } from 'vitest';
import { PERMISSIONS } from '../../src/permissions/permissions';
import { sellerEvidenceDeleteRoles, sellerEvidenceDownloadRoles, sellerEvidenceRoles, sellerNoteRoles, sellerReadRoles, sellerSettingsRoles, authorityReviewRoles, sellerWorkRoles } from '../../src/admin/shared';
import { applyOverrides, policyFromEnv, SETTING_DEFS, settingDef, validateSettingValue } from '../../src/seller/policy';
import { EVIDENCE_MAX_BYTES, evidenceKey, safeFilename, validateEvidenceFile } from '../../src/seller/evidence-files';
import { evidenceDeleteSchema, evidenceReasonSchema, policyChangeSchema } from '../../src/seller/seller-schemas';

const sorted = (a: readonly string[]) => [...a].sort();
const pdf = new TextEncoder().encode('%PDF-1.7 test');

describe('compliance role permissions', () => {
  it('route role lists equal the permission map', () => {
    expect(sorted(sellerReadRoles)).toEqual(sorted(PERMISSIONS['seller_enquiries.read']));
    expect(sorted(sellerReadRoles)).toEqual(sorted(PERMISSIONS['sellers.read']));
    expect(sorted(authorityReviewRoles)).toEqual(sorted(PERMISSIONS['authority.review']));
    expect(sorted(authorityReviewRoles)).toEqual(sorted(PERMISSIONS['authority.approve']));
    expect(sorted(sellerEvidenceRoles)).toEqual(sorted(PERMISSIONS['authority.submit_evidence']));
    expect(sorted(sellerEvidenceDownloadRoles)).toEqual(sorted(PERMISSIONS['authority.download_evidence']));
    expect(sorted(sellerEvidenceDeleteRoles)).toEqual(sorted(PERMISSIONS['authority.delete_evidence']));
    expect(sorted(sellerNoteRoles)).toEqual(sorted(PERMISSIONS['seller_enquiries.add_note']));
    expect(sorted(sellerSettingsRoles)).toEqual(sorted(PERMISSIONS['seller_settings.manage']));
  });
  it('compliance reads, verifies and downloads evidence, but cannot assign, close, send, publish, retain or work as a broker', () => {
    expect(PERMISSIONS['seller_enquiries.read']).toContain('compliance');
    expect(PERMISSIONS['authority.review']).toContain('compliance');
    expect(PERMISSIONS['authority.download_evidence']).toContain('compliance');
    for (const k of ['seller_enquiries.assign', 'seller_enquiries.close', 'seller_enquiries.update_status', 'seller_enquiries.record_communication', 'seller_followups.manage', 'seller_communications.send', 'seller_material_interest.record',
      'seller_material_interest.approve', 'seller_material_interest.send', 'seller_retention.manage', 'seller_enquiries.export', 'opportunities.create_draft', 'opportunities.approve_publication', 'sellers.create', 'sellers.update', 'authority.delete_evidence', 'seller_settings.manage'] as const)
      expect(PERMISSIONS[k], k).not.toContain('compliance');
    expect(sellerWorkRoles).not.toContain('compliance');
  });
  it('evidence deletion and sensitive settings are not available to brokers or publishers', () => {
    for (const k of ['authority.delete_evidence', 'seller_settings.manage', 'seller_settings.manage_sensitive'] as const) { expect(PERMISSIONS[k]).not.toContain('broker'); expect(PERMISSIONS[k]).not.toContain('publisher'); }
    expect(PERMISSIONS['seller_settings.manage_sensitive']).toEqual(['super_admin']);
    expect(PERMISSIONS['authority.download_evidence']).not.toContain('broker');
  });
});

describe('evidence file validation', () => {
  it('accepts matching type, extension and signature', () => {
    expect(validateEvidenceFile('mandate.pdf', 'application/pdf', pdf)).toMatchObject({ ok: true, contentType: 'application/pdf', extension: 'pdf' });
    expect(validateEvidenceFile('scan.PNG', 'image/png', new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]))).toMatchObject({ ok: true });
    expect(validateEvidenceFile('x.docx', '', new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0]))).toMatchObject({ ok: true });
  });
  it('rejects wrong extensions, mismatched declarations, bad signatures, empty and oversized files', () => {
    expect(validateEvidenceFile('run.exe', 'application/pdf', pdf).ok).toBe(false);
    expect(validateEvidenceFile('mandate.pdf', 'image/png', pdf).ok).toBe(false);
    expect(validateEvidenceFile('mandate.pdf', 'application/pdf', new TextEncoder().encode('<html>not a pdf</html>')).ok).toBe(false);
    expect(validateEvidenceFile('mandate.pdf', 'application/pdf', new Uint8Array(0)).ok).toBe(false);
    expect(validateEvidenceFile('noextension', '', pdf).ok).toBe(false);
    expect(validateEvidenceFile('big.pdf', 'application/pdf', Object.assign(new Uint8Array(EVIDENCE_MAX_BYTES + 1), pdf)).ok).toBe(false);
    expect(validateEvidenceFile('pdf.html', 'text/html', pdf).ok).toBe(false);
  });
  it('display names are sanitised and storage keys never use them', () => {
    expect(safeFilename('../../etc/passwd')).toBe('passwd');
    expect(safeFilename('a"b<c>\r\nd.pdf')).toBe('a_b_c_d.pdf');
    expect(safeFilename('x'.repeat(300)).length).toBe(120);
    expect(evidenceKey('rec-1', 'obj-2', 'pdf')).toBe('seller-evidence/rec-1/obj-2.pdf');
  });
  it('delete and reason inputs need confirmation', () => {
    expect(evidenceReasonSchema.safeParse({ reason: 'Superseded', confirm: true }).success).toBe(true);
    expect(evidenceReasonSchema.safeParse({ reason: 'Superseded' }).success).toBe(false);
    expect(evidenceDeleteSchema.safeParse({ reason: 'Erasure', confirmId: '11111111-1111-4111-8111-111111111111', confirm: true }).success).toBe(true);
    expect(evidenceDeleteSchema.safeParse({ reason: 'Erasure', confirmId: 'nope', confirm: true }).success).toBe(false);
  });
});

describe('seller policy', () => {
  it('defaults match the previous environment behaviour', () => {
    const p = policyFromEnv({});
    expect(p).toMatchObject({ remindersEnabled: true, reminderIntervalHours: 24, escalationAfterHours: 0, separationOfDuties: true, materialInterestDualApproval: false, retentionReviewDays: null, marketingConsentEnabled: false, alertRecipients: [] });
    const e = policyFromEnv({ SELLER_ALERT_RECIPIENTS: 'a@x.co, bad, b@x.co', SELLER_SEPARATION_OF_DUTIES: 'false', SELLER_RETENTION_REVIEW_DAYS: '90' });
    expect(e).toMatchObject({ alertRecipients: ['a@x.co', 'b@x.co'], separationOfDuties: false, retentionReviewDays: 90 });
  });
  it('database values win, invalid ones are ignored, and the source is reported', () => {
    const base = policyFromEnv({ SELLER_REMINDER_INTERVAL_HOURS: '12' });
    const { policy, sources } = applyOverrides(base, [
      { key: 'reminder_interval_hours', value: '6', version: 1, updatedAt: '' },
      { key: 'separation_of_duties', value: '"false"', version: 1, updatedAt: '' },
      { key: 'escalation_after_hours', value: '5000', version: 1, updatedAt: '' },
      { key: 'unknown_key', value: 'true', version: 1, updatedAt: '' },
      { key: 'alert_recipients', value: 'not json', version: 1, updatedAt: '' },
    ], { SELLER_REMINDER_INTERVAL_HOURS: '12' });
    expect(policy.reminderIntervalHours).toBe(6);
    expect(policy.separationOfDuties).toBe(true);
    expect(policy.escalationAfterHours).toBe(0);
    expect(sources['reminder_interval_hours']).toBe('database');
    expect(sources['separation_of_duties']).toBe('default');
    expect(applyOverrides(base, [], { SELLER_REMINDER_INTERVAL_HOURS: '12' }).sources['reminder_interval_hours']).toBe('environment');
  });
  it('validates every kind strictly', () => {
    const d = (k: string) => settingDef(k)!;
    expect(validateSettingValue(d('reminders_enabled'), true)).toEqual({ ok: true, value: true });
    expect(validateSettingValue(d('reminders_enabled'), 'true').ok).toBe(false);
    expect(validateSettingValue(d('reminder_interval_hours'), 0).ok).toBe(false);
    expect(validateSettingValue(d('reminder_interval_hours'), 169).ok).toBe(false);
    expect(validateSettingValue(d('reminder_interval_hours'), 1.5).ok).toBe(false);
    expect(validateSettingValue(d('retention_review_days'), null)).toEqual({ ok: true, value: null });
    expect(validateSettingValue(d('retention_review_days'), 0).ok).toBe(false);
    expect(validateSettingValue(d('alert_recipients'), ['A@X.co', 'a@x.co'])).toEqual({ ok: true, value: ['a@x.co'] });
    expect(validateSettingValue(d('alert_recipients'), ['nope']).ok).toBe(false);
    expect(validateSettingValue(d('alert_recipients'), Array(11).fill('a@x.co')).ok).toBe(false);
    expect(validateSettingValue(d('reminder_interval_hours'), null).ok).toBe(false);
  });
  it('flags exactly the safeguard-weakening settings as sensitive', () => {
    expect(SETTING_DEFS.filter((d) => d.sensitive).map((d) => d.key).sort()).toEqual(['marketing_consent_enabled', 'material_interest_dual_approval', 'retention_review_days', 'separation_of_duties']);
    expect(policyChangeSchema.safeParse({ value: true, expectedVersion: 0, reason: 'Legal approved', confirm: true }).success).toBe(true);
    expect(policyChangeSchema.safeParse({ value: true, expectedVersion: 0, reason: 'x', confirm: true }).success).toBe(false);
  });
});
