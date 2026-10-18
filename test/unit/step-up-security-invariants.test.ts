import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  STEP_UP_WINDOW_SECONDS,
  safeReturnPath,
  stepUpDecision,
  stepUpMessage,
} from '../../src/auth/step-up-policy';

const read = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8');
const T = Date.parse('2026-10-17T12:00:00.000Z');
const ago = (s: number) => new Date(T - s * 1000).toISOString();

describe('step-up policy', () => {
  it('passes when verified inside the window and fails just outside it', () => {
    expect(stepUpDecision({ enrolled: true, verifiedAt: ago(5) }, T)).toBe('ok');
    expect(stepUpDecision({ enrolled: true, verifiedAt: ago(STEP_UP_WINDOW_SECONDS) }, T)).toBe('ok');
    expect(stepUpDecision({ enrolled: true, verifiedAt: ago(STEP_UP_WINDOW_SECONDS + 1) }, T)).toBe('step_up_required');
  });

  it('fails closed on missing state, missing/garbled/future timestamps', () => {
    expect(stepUpDecision(undefined, T)).toBe('step_up_required');
    expect(stepUpDecision({ enrolled: true, verifiedAt: null }, T)).toBe('step_up_required');
    expect(stepUpDecision({ enrolled: true, verifiedAt: 'not-a-date' }, T)).toBe('step_up_required');
    expect(stepUpDecision({ enrolled: true, verifiedAt: ago(-3600) }, T)).toBe('step_up_required');
  });

  it('cannot step up staff without an enrolled factor (sign-in policy covers them)', () => {
    expect(stepUpDecision({ enrolled: false, verifiedAt: null }, T)).toBe('ok');
  });

  it('honours a custom window', () => {
    expect(stepUpDecision({ enrolled: true, verifiedAt: ago(120) }, T, 60)).toBe('step_up_required');
    expect(stepUpDecision({ enrolled: true, verifiedAt: ago(30) }, T, 60)).toBe('ok');
  });
});

describe('safeReturnPath', () => {
  it('accepts same-site paths and rejects anything that could leave the site', () => {
    expect(safeReturnPath('/staff/ui')).toBe('/staff/ui');
    expect(safeReturnPath('/dashboard?tab=staff&x=1')).toBe('/dashboard?tab=staff&x=1');
    for (const bad of ['//evil.com', 'https://evil.com', 'javascript:alert(1)', '/\\evil.com', 'staff', '', '/a b', '/<script>', null, undefined, 42, '/' + 'a'.repeat(250)])
      expect(safeReturnPath(bad)).toBe('/dashboard');
    expect(safeReturnPath('//evil.com', '/staff/ui')).toBe('/staff/ui');
  });

  it('builds a message that only ever contains a safe, encoded path', () => {
    expect(stepUpMessage('/staff/ui')).toContain('/admin/mfa?stepup=1&next=%2Fstaff%2Fui');
    expect(stepUpMessage('//evil.com')).toContain('next=%2Fdashboard');
  });
});

describe('step-up wiring', () => {
  it('guards every staff-management mutation after the role check', () => {
    const src = read('src/admin/routes/staff.ts');
    for (const route of ["admin.post('/staff'", "admin.patch('/staff/:id'", "admin.post('/staff/:id/temporary-password'", "admin.post('/staff/:id/reset-password'"])
      expect(src).toContain(`${route}, requireRole('super_admin'), requireRecentMfa('/staff/ui'),`);
    expect(src).not.toMatch(/admin\.(get)\('\/staff[^']*', requireRole\('super_admin'\), requireRecentMfa/);
  });

  it('guards document deletion/overrides, buyer credential changes and NDA decisions; never access revocation', () => {
    const docs = read('src/admin/routes/documents.ts');
    for (const route of ["admin.put('/scanner-settings'", "admin.patch('/documents/:id/scan-status'", "admin.delete('/documents/:id'"])
      expect(docs).toMatch(new RegExp(route.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ", requireRole\\([^)]*\\), requireRecentMfa"));
    const buyers = read('src/admin/routes/buyers.ts');
    for (const route of ["'/buyers/:id/temporary-password'", "'/buyers/:id/reset-password'", "'/buyers/provision'"])
      expect(buyers).toMatch(new RegExp(route + ", requireRole\\([^)]*\\), requireRecentMfa"));
    const nda = read('src/admin/routes/nda.ts');
    expect(nda).toMatch(/'\/nda-requests\/:id\/review',\s+requireRole\([^)]*\),\s+requireRecentMfa/);
    expect(nda).toMatch(/'\/nda-templates\/:id\/activate', requireRole\([^)]*\), requireRecentMfa/);
    // Revoking access is protective and must stay fast.
    expect(read('src/admin/routes/access-grants.ts')).not.toContain('requireRecentMfa');
  });

  it('requires step-up for MFA reset and returns to a validated path after verifying', () => {
    const src = read('src/auth/mfa-routes.ts');
    expect(src).toMatch(/STEP_UP_REQUIRED/);
    expect(src).toMatch(/redirectTo: safeReturnPath\(input\.data\.next\)/);
    expect(src).toMatch(/data-next="\$\{escapeAttr\(safeReturnPath\(/);
  });

  it('exposes verification time only through the session state and middleware fails closed without it', () => {
    expect(read('src/auth/staff-session.ts')).toMatch(/verifiedAt: row\.mfaAt/);
    expect(read('src/auth/step-up.ts')).toMatch(/c\.get\('mfa'\)/);
    expect(read('src/auth/step-up.ts')).toMatch(/403/);
  });
});

describe('step-up dialog (client)', () => {
  const js = read('public/static/js/dashboard-step-up.js');

  it('is injected on every dashboard page before the shell', () => {
    const index = read('src/index.ts');
    expect(index).toMatch(/dashboard-step-up\.js[^]*dashboard-shell\.js/);
  });

  it('only reacts to STEP_UP_REQUIRED on same-origin staff endpoints and never wraps the verify call itself', () => {
    expect(js).toContain("code !== 'STEP_UP_REQUIRED'");
    expect(js).toContain('url.origin === window.location.origin');
    expect(js).toMatch(/startsWith\('\/api\/admin\/mfa\/verify'\)/);
    expect(js).toMatch(/response\.status !== 403/);
  });

  it('retries the original request at most once and returns the original refusal on cancel', () => {
    expect(js).toMatch(/if \(!\(await prompt\(\)\)\) return response;/);
    expect(js.match(/nativeFetch\(retryable \|\| input/g)?.length).toBe(1);
  });

  it('builds the dialog with DOM APIs only: no innerHTML, no inline styles, no eval', () => {
    expect(js).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(|new Function|\.style\b|setAttribute\('style'/);
    expect(js).toContain('textContent');
  });

  it('has styles for the dialog in the dashboard stylesheet', () => {
    expect(read('public/static/css/dashboard-media.css')).toContain('.step-up-dialog');
  });
});
