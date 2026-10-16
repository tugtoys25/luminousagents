import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { emailInUse, findActiveStaffContact, findStaff, findStaffContact, insertStaff, isActiveStaff, listStaff, updateStaffAndRevoke } from '../../src/admin/repos/staff-repo';
import { enquiryVisible, findEnquiryRef, getEnquiry, insertNote, listAssignees, listEnquiries, listNotes, updateEnquiry } from '../../src/admin/repos/enquiries-repo';

const ts = '2026-03-01T10:00:00.000Z';

// Each test seeds what it needs, so the file passes whether or not storage is isolated per test.
async function seedStaff(): Promise<void> {
  if (!(await findStaff(env.DB, 'sr-1')))
    await insertStaff(env.DB, { id: 'sr-1', email: 'sr-1@example.com', displayName: 'Sr One', role: 'broker', passwordHash: null, timestamp: ts });
  if (!(await findStaff(env.DB, 'sr-2')))
    await insertStaff(env.DB, { id: 'sr-2', email: 'sr-2@example.com', displayName: 'Sr Two', role: 'admin', passwordHash: 'hash', timestamp: ts });
  await env.DB.prepare(
    "INSERT OR IGNORE INTO users (id, email, display_name, role, user_type, status, created_at, updated_at) VALUES ('sr-buyer', 'sr-buyer@example.com', 'B', 'buyer', 'buyer', 'active', ?, ?)",
  ).bind(ts, ts).run();
}

describe('staff repo', () => {
  it('creates, lists and finds staff; never returns buyers', async () => {
    await insertStaff(env.DB, { id: 'sr-1', email: 'sr-1@example.com', displayName: 'Sr One', role: 'broker', passwordHash: null, timestamp: ts });
    await insertStaff(env.DB, { id: 'sr-2', email: 'sr-2@example.com', displayName: 'Sr Two', role: 'admin', passwordHash: 'hash', timestamp: ts });
    await env.DB.prepare(
      "INSERT INTO users (id, email, display_name, role, user_type, status, created_at, updated_at) VALUES ('sr-buyer', 'sr-buyer@example.com', 'B', 'buyer', 'buyer', 'active', ?, ?)",
    ).bind(ts, ts).run();

    const rows = await listStaff(env.DB);
    const one = rows.find((r) => r['id'] === 'sr-1');
    const two = rows.find((r) => r['id'] === 'sr-2');
    expect(one?.['hasPassword']).toBe(0);
    expect(two).toMatchObject({ hasPassword: 1, mustChange: 1 });
    expect(rows.some((r) => r['id'] === 'sr-buyer')).toBe(false);

    expect((await findStaff(env.DB, 'sr-1'))?.role).toBe('broker');
    expect(await findStaff(env.DB, 'sr-buyer')).toBeNull();
    expect((await findStaffContact(env.DB, 'sr-2'))?.email).toBe('sr-2@example.com');
    expect(await isActiveStaff(env.DB, 'sr-1')).toBe(true);
    expect(await isActiveStaff(env.DB, 'sr-buyer')).toBe(false);
  });
  it('detects email clashes case-insensitively, excluding the account itself', async () => {
    await seedStaff();
    expect(await emailInUse(env.DB, 'SR-1@EXAMPLE.COM')).toBe(true);
    expect(await emailInUse(env.DB, 'sr-1@example.com', 'sr-1')).toBe(false);
    expect(await emailInUse(env.DB, 'sr-1@example.com', 'sr-2')).toBe(true);
    expect(await emailInUse(env.DB, 'nobody@example.com')).toBe(false);
  });
  it('revokes sessions only for security-relevant changes, atomically with the update', async () => {
    await seedStaff();
    const mk = (id: string, hash: string) =>
      env.DB.prepare(
        "INSERT INTO sessions (id, user_id, token_hash, created_at, last_seen_at, expires_at, session_type) VALUES (?, 'sr-1', ?, ?, ?, '2099-01-01T00:00:00.000Z', 'staff')",
      ).bind(id, hash, ts, ts).run();
    await mk('sess-a', 'h-a');
    await updateStaffAndRevoke(env.DB, { id: 'sr-1', role: 'broker', status: 'active', displayName: 'Renamed', email: 'sr-1@example.com', securityChange: false, timestamp: '2026-04-01T00:00:00.000Z' });
    let s = await env.DB.prepare("SELECT revoked_at AS r FROM sessions WHERE id='sess-a'").first<{ r: string | null }>();
    expect(s?.r).toBeNull();
    expect((await findStaff(env.DB, 'sr-1'))?.displayName).toBe('Renamed');
    await updateStaffAndRevoke(env.DB, { id: 'sr-1', role: 'editor', status: 'active', displayName: 'Renamed', email: 'sr-1@example.com', securityChange: true, timestamp: '2026-04-02T00:00:00.000Z' });
    s = await env.DB.prepare("SELECT revoked_at AS r FROM sessions WHERE id='sess-a'").first<{ r: string | null }>();
    expect(s?.r).toBe('2026-04-02T00:00:00.000Z');
    await updateStaffAndRevoke(env.DB, { id: 'sr-1', role: 'editor', status: 'suspended', displayName: 'Renamed', email: 'sr-1@example.com', securityChange: true, timestamp: '2026-04-03T00:00:00.000Z' });
    expect(await findActiveStaffContact(env.DB, 'sr-1')).toBeNull();
  });
});

describe('enquiries repo', () => {
  const insert = (id: string, name: string, status: string, assignedTo: string | null) =>
    env.DB.prepare(
      "INSERT OR IGNORE INTO enquiries (id, name, email, company, message, source, status, assigned_to, consent_at, created_at, updated_at) VALUES (?, ?, ?, 'Acme', 'a long enough message', 'website', ?, ?, ?, ?, ?)",
    ).bind(id, name, `${id}@example.com`, status, assignedTo, ts, ts, ts).run();

  it('scopes brokers, filters by status and search, and updates selectively', async () => {
    await seedStaff();
    await insert('enq-1', 'Alice Mine', 'new', 'sr-1');
    await insert('enq-2', 'Bob Other', 'closed', null);

    const adminView = await listEnquiries(env.DB, { status: '', q: '', brokerOnly: 0, staffId: 'x' });
    expect(adminView.map((r) => r['id']).filter((i) => String(i).startsWith('enq-')).sort()).toEqual(['enq-1', 'enq-2']);
    const brokerView = await listEnquiries(env.DB, { status: '', q: '', brokerOnly: 1, staffId: 'sr-1' });
    expect(brokerView.map((r) => r['id'])).toEqual(['enq-1']);
    expect((await listEnquiries(env.DB, { status: 'closed', q: '', brokerOnly: 0, staffId: 'x' })).map((r) => r['id'])).toEqual(['enq-2']);
    expect((await listEnquiries(env.DB, { status: '', q: 'Alice', brokerOnly: 0, staffId: 'x' })).map((r) => r['id'])).toEqual(['enq-1']);

    expect(await getEnquiry(env.DB, 'enq-2', 1, 'sr-1')).toBeNull();
    expect((await findEnquiryRef(env.DB, 'enq-1', 1, 'sr-1'))?.status).toBe('new');
    expect(await enquiryVisible(env.DB, 'enq-2', 1, 'sr-1')).toBe(false);
    expect(await enquiryVisible(env.DB, 'enq-2', 0, 'sr-1')).toBe(true);

    await updateEnquiry(env.DB, 'enq-1', { status: 'in_progress' }, false, '2026-05-01T00:00:00.000Z');
    let ref = await findEnquiryRef(env.DB, 'enq-1', 0, 'x');
    expect(ref).toMatchObject({ status: 'in_progress', assignedTo: 'sr-1' });
    await updateEnquiry(env.DB, 'enq-1', { assignedTo: null }, true, '2026-05-02T00:00:00.000Z');
    ref = await findEnquiryRef(env.DB, 'enq-1', 0, 'x');
    expect(ref).toMatchObject({ status: 'in_progress', assignedTo: null });
  });
  it('stores notes newest first with the author email', async () => {
    await seedStaff();
    await insert('enq-1', 'Alice Mine', 'new', 'sr-1');
    await insertNote(env.DB, { id: 'n1', enquiryId: 'enq-1', authorId: 'sr-2', note: 'first', timestamp: '2026-06-01T00:00:00.000Z' });
    await insertNote(env.DB, { id: 'n2', enquiryId: 'enq-1', authorId: 'sr-2', note: 'second', timestamp: '2026-06-02T00:00:00.000Z' });
    const notes = await listNotes(env.DB, 'enq-1');
    expect(notes.map((n) => n['note'])).toEqual(['second', 'first']);
    expect(notes[0]!['authorEmail']).toBe('sr-2@example.com');
  });
  it('lists assignable staff only', async () => {
    await seedStaff();
    const ids = (await listAssignees(env.DB)).map((r) => r['id']);
    expect(ids.includes('sr-2')).toBe(true);
    expect(ids.includes('sr-buyer')).toBe(false);
  });
});
