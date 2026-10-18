import { describe, expect, it } from 'vitest';
import { insertSellerEnquiry, isUniqueViolation, type SellerEnquiryInsert } from '../../src/seller/repo';
import { normaliseSellerEnquiry, sellerEnquirySchema } from '../../src/seller/schema';
import { valid } from '../support/seller-fixtures';

type Stmt = { sql: string; args: unknown[] };
const fake = () => {
  const batches: Stmt[][] = [];
  const db = { prepare: (sql: string) => ({ bind: (...args: unknown[]) => ({ sql, args }) }), batch: async (s: Stmt[]) => void batches.push(s) };
  return { db: db as unknown as D1Database, batches };
};
const insert = (): SellerEnquiryInsert => {
  const p = sellerEnquirySchema.parse(valid());
  return { id: 'e1', reference: 'CM-S-ABC234', data: normaliseSellerEnquiry(p, false), idempotencyHash: 'h', sourceIpHash: null, requestId: 'r', auditId: 'a', ackJobId: 'j1', alertJobId: 'j2', timestamp: '2026-10-18T00:00:00.000Z' };
};

describe('insertSellerEnquiry', () => {
  it('writes enquiry, audit and both jobs in one batch with NEW status and logical dedupe keys', async () => {
    const f = fake();
    await insertSellerEnquiry(f.db, insert());
    expect(f.batches).toHaveLength(1);
    const [enquiry, audit, ack, alert] = f.batches[0]!;
    expect(enquiry!.sql).toContain("'NEW'");
    expect(audit!.sql).toContain("'seller_enquiry.created'");
    expect(ack!.args).toContain('seller_enquiry_ack:e1');
    expect(alert!.args).toContain('seller_enquiry_internal_alert:e1');
  });
  it('records consent versions/timestamps and keeps job payloads free of personal data', async () => {
    const f = fake();
    await insertSellerEnquiry(f.db, insert());
    const [enquiry, , ack] = f.batches[0]!;
    expect(enquiry!.args).toContain('seller-form-privacy-ack-v1');
    expect(enquiry!.args).toContain('seller-form-accuracy-v1');
    expect(ack!.args[2]).toBe('{"enquiryId":"e1"}');
  });
  it('preserves the original submission without the idempotency key', async () => {
    const f = fake();
    await insertSellerEnquiry(f.db, insert());
    const json = String(f.batches[0]![0]!.args.find((a) => typeof a === 'string' && a.startsWith('{"contact_name"')));
    expect(json).toContain('Jane Owner');
    expect(json).not.toContain('idempotency_key');
  });
  it('detects unique violations only', () => {
    expect(isUniqueViolation(new Error('D1_ERROR: UNIQUE constraint failed: seller_enquiries.reference'))).toBe(true);
    expect(isUniqueViolation(new Error('boom'))).toBe(false);
  });
});
