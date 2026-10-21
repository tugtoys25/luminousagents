import { Hono } from 'hono';
import { requireRole } from '../../auth/staff-session';
import { SETTING_DEFS, settingDef, validateSettingValue, type SettingDef } from '../../seller/policy';
import { loadSellerPolicyDetail } from '../../seller/policy-load';
import { resetPolicy, writePolicy } from '../../seller/policy-repo';
import { policyChangeSchema } from '../../seller/seller-schemas';
import { jsonError, readJson, stepUpResponse } from '../../seller/staff-access';
import { type AdminApp, id, now, sellerSettingsRoles } from '../shared';

const admin = new Hono<AdminApp>();

admin.get('/seller-settings/ui', requireRole(...sellerSettingsRoles), async (c) =>
  c.html(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Seller settings · Casinos of Mayfair</title><link rel="stylesheet" href="/static/css/site.css"><link rel="stylesheet" href="/static/css/dashboard.css"></head><body><main class="admin"><p class="eyebrow">STAFF WORKSPACE</p><h1>Seller workflow settings</h1><nav class="admin-nav"><a href="/dashboard">Overview</a><a href="/dashboard/seller-enquiries/ui">Seller enquiries</a><a href="/dashboard/seller-settings/ui">Settings</a><a href="/admin/logout">Sign out</a></nav><p class="muted">A saved value overrides the environment variable. Reset returns to the environment value or default. Settings marked sensitive weaken a safeguard or affect legal posture: super admin only, recent MFA, and a reason is recorded.</p><p id="ss-notice" role="status"></p><section id="ss-list" aria-live="polite">Loading…</section></main><dialog id="ss-confirm"><form method="dialog"><p id="ss-confirm-text"></p><label>Reason (required) <textarea id="ss-reason" maxlength="500" rows="3"></textarea></label><menu><button value="cancel">Cancel</button><button value="ok" class="button button-primary">Confirm</button></menu></form></dialog><script src="/static/js/dashboard-seller-settings.js" defer></script></body></html>`,
  ),
);

const summary = (def: SettingDef, value: unknown): unknown => (def.kind === 'emails' ? { count: Array.isArray(value) ? value.length : 0 } : value);

admin.get('/seller-settings', requireRole(...sellerSettingsRoles), async (c) => {
  const { policy, sources, rows } = await loadSellerPolicyDetail(c.env);
  const isSuper = c.get('staff').role === 'super_admin';
  c.header('Cache-Control', 'private, no-store');
  return c.json({
    data: SETTING_DEFS.map((def) => {
      const row = rows.find((r) => r.key === def.key);
      return { key: def.key, label: def.label, description: def.description, kind: def.kind, min: def.min ?? null, max: def.max ?? null, sensitive: def.sensitive, editable: !def.sensitive || isSuper,
        value: policy[def.field], source: sources[def.key], version: row?.version ?? 0, updatedAt: row?.updatedAt ?? null, updatedBy: row?.updatedByName ?? null };
    }),
  });
});

/** Change or reset one setting. Sensitive settings need a super admin and recent MFA. Every change is version-checked and audited atomically. */
admin.post('/seller-settings/:key', requireRole(...sellerSettingsRoles), async (c) => {
  const def = settingDef(c.req.param('key') ?? '');
  if (!def) return jsonError(c, 404, 'NOT_FOUND', 'Unknown setting.');
  const parsed = policyChangeSchema.safeParse(await readJson(c));
  if (!parsed.success) return jsonError(c, 422, 'VALIDATION_ERROR', 'Provide the version, a reason of at least 5 characters, and confirmation.');
  const staff = c.get('staff');
  if (def.sensitive) {
    if (staff.role !== 'super_admin') return jsonError(c, 403, 'FORBIDDEN', 'Only a super admin can change this setting.');
    const stepUp = stepUpResponse(c, '/dashboard/seller-settings/ui');
    if (stepUp) return stepUp;
  }
  const { policy, rows } = await loadSellerPolicyDetail(c.env);
  const before = policy[def.field];
  const base = { id: staff.id, requestId: c.get('requestId'), ts: now(), key: def.key, expectedVersion: parsed.data.expectedVersion, reason: parsed.data.reason, auditId: id() };
  if (parsed.data.reset) {
    if (!rows.some((r) => r.key === def.key)) return jsonError(c, 409, 'NO_CHANGE', 'This setting already uses the environment value or default.');
    if (!(await resetPolicy(c.env.DB, { ...base, auditDetails: { key: def.key, from: summary(def, before) } }))) return jsonError(c, 409, 'VERSION_CONFLICT', 'This setting changed. Reload and try again.');
    return c.json({ data: { key: def.key, reset: true } });
  }
  const checked = validateSettingValue(def, parsed.data.value);
  if (!checked.ok) return jsonError(c, 422, 'VALIDATION_ERROR', checked.message);
  if (JSON.stringify(checked.value) === JSON.stringify(before) && rows.some((r) => r.key === def.key)) return jsonError(c, 409, 'NO_CHANGE', 'That is already the stored value.');
  if (!(await writePolicy(c.env.DB, { ...base, value: checked.value, auditDetails: { key: def.key, from: summary(def, before), to: summary(def, checked.value) } }))) return jsonError(c, 409, 'VERSION_CONFLICT', 'This setting changed. Reload and try again.');
  return c.json({ data: { key: def.key, value: checked.value } });
});

export default admin;
