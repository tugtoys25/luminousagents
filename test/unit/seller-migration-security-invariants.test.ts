import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (p: string) => readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');

describe('seller migrations and public surface (static checks)', () => {
  const m32 = read('migrations/0032_seller_enquiries.sql');
  it('enforces a unique public reference, idempotency hash and explicit status constraint', () => {
    expect(m32).toMatch(/reference TEXT NOT NULL UNIQUE/);
    expect(m32).toMatch(/idempotency_hash TEXT NOT NULL UNIQUE/);
    expect(m32).toMatch(/status IN \('NEW','ASSIGNED','CONTACT_ATTEMPTED','AWAITING_SELLER','QUALIFICATION','AUTHORITY_REVIEW','QUALIFIED','CONVERTED','DECLINED','CLOSED'\)/);
  });
  it('is forward-only: no DROP or DELETE', () => {
    expect(m32).not.toMatch(/\bDROP\s+(TABLE|COLUMN)|\bDELETE\s+FROM/i);
  });
  it('makes audit_logs append-only', () => {
    const m33 = read('migrations/0033_audit_append_only.sql');
    expect(m33).toMatch(/BEFORE UPDATE ON audit_logs/);
    expect(m33).toMatch(/BEFORE DELETE ON audit_logs/);
  });
  it('seller route has no direct SQL and the submit path is Turnstile protected', () => {
    expect(read('src/seller/routes.ts')).not.toMatch(/\.prepare\(/);
    expect(read('src/security/turnstile.ts')).toContain("'/api/sell-a-casino'");
  });
  it('public page offers no file upload and links the real privacy route', () => {
    const page = read('src/web/pages/public-sell.tsx');
    expect(page).not.toMatch(/type="file"/);
    expect(page).toContain('href="/legal/privacy"');
  });
  it('seller code never logs request bodies', () => {
    expect(read('src/seller/routes.ts')).not.toMatch(/console\.\w+\([^)]*(body|parsed|raw)\b/);
  });
});
