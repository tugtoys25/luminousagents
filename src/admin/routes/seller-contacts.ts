import { Hono } from 'hono';
import { requireRole } from '../../auth/staff-session';
import { insertContact, removeContact } from '../../seller/seller-repo';
import { loadSeller } from '../../seller/seller-access';
import { contactSchema } from '../../seller/seller-schemas';
import { jsonError, readJson } from '../../seller/staff-access';
import { type AdminApp, id, now, sellerWorkRoles } from '../shared';

const admin = new Hono<AdminApp>();

/** Several people can be recorded against one seller organisation. Notices are never copied to them automatically. */
admin.post('/sellers/:ref/contacts', requireRole(...sellerWorkRoles), async (c) => {
  const parsed = contactSchema.safeParse(await readJson(c));
  if (!parsed.success) return jsonError(c, 422, 'VALIDATION_ERROR', 'Provide a name and a valid email address.');
  const seller = await loadSeller(c);
  if (seller instanceof Response) return seller;
  const contactId = id();
  const ok = await insertContact(c.env.DB, { id: c.get('staff').id, requestId: c.get('requestId'), ts: now(), seller, contactId, name: parsed.data.name, roleTitle: parsed.data.roleTitle ?? '', email: parsed.data.email.toLowerCase(), telephone: parsed.data.telephone ?? null, auditId: id() });
  if (!ok) return jsonError(c, 409, 'INVALID_STATE', 'Contacts cannot be added to an inactive or anonymised seller.');
  return c.json({ data: { id: contactId } }, 201);
});

admin.post('/sellers/:ref/contacts/:contactId/remove', requireRole(...sellerWorkRoles), async (c) => {
  const seller = await loadSeller(c);
  if (seller instanceof Response) return seller;
  const contactId = c.req.param('contactId') ?? '';
  if (!/^[0-9a-f-]{36}$/.test(contactId)) return jsonError(c, 404, 'NOT_FOUND', 'Contact not found.');
  if (!(await removeContact(c.env.DB, { id: c.get('staff').id, requestId: c.get('requestId'), ts: now(), seller, contactId, auditId: id() }))) return jsonError(c, 404, 'NOT_FOUND', 'Contact not found.');
  return c.json({ data: { removed: true } });
});

export default admin;
