import { Hono } from 'hono';
import { z } from 'zod';
import { requireRole } from '../../auth/staff-session';
import { COLLECTIONS, getCollection } from '../../site-content/registry';
import { DEFAULT_ID_PREFIX, resolveForAdmin } from '../../site-content/resolve';
import { describeCollection, validateItem } from '../../site-content/validate';
import {
  addItem, countStored, deleteItem, isCustomised, listStored, loadAllStored, reorderItems, resetCollection,
  seedCollection, updateItem, type NewItem,
} from '../../site-content/site-content-repo';
import { type AdminApp, audit, id, now } from '../shared';

const admin = new Hono<AdminApp>();

const err = (code: string, message: string, extra: Record<string, unknown> = {}) => ({ error: { code, message, ...extra } });
const unknown = () => err('UNKNOWN_COLLECTION', 'Unknown content collection.');

const itemBody = z.object({ enabled: z.boolean().optional(), data: z.record(z.string(), z.unknown()).optional() });

/** Built-in items as storable rows, used to copy built-in content into the database on first edit. */
const seedFor = (key: string): NewItem[] =>
  (getCollection(key)?.defaults ?? []).map((data, index) => ({ id: id(), sortOrder: index, enabled: true, data: { ...data } }));

admin.get('/site-content/api/schema', requireRole('admin', 'super_admin', 'editor'), async (c) => {
  const stored = await loadAllStored(c.env.DB);
  return c.json({
    data: COLLECTIONS.map((def) => ({
      ...describeCollection(def),
      customised: stored.customised.includes(def.key),
      count: resolveForAdmin(def, stored).items.length,
    })),
  });
});

admin.get('/site-content/api/:collection', requireRole('admin', 'super_admin', 'editor'), async (c) => {
  const def = getCollection(c.req.param('collection'));
  if (!def) return c.json(unknown(), 404);
  const stored = await loadAllStored(c.env.DB);
  return c.json({ data: { ...describeCollection(def), ...resolveForAdmin(def, stored) } });
});

admin.post('/site-content/api/:collection/customise', requireRole('admin', 'super_admin', 'editor'), async (c) => {
  const def = getCollection(c.req.param('collection'));
  if (!def) return c.json(unknown(), 404);
  if (!(await isCustomised(c.env.DB, def.key))) {
    await seedCollection(c.env.DB, def.key, seedFor(def.key), c.get('staff').id, now());
    await audit(c, 'site_content.customised', 'site_content', def.key);
  }
  return c.json({ data: { collection: def.key, customised: true } });
});

admin.post('/site-content/api/:collection/items', requireRole('admin', 'super_admin', 'editor'), async (c) => {
  const def = getCollection(c.req.param('collection'));
  if (!def) return c.json(unknown(), 404);
  if (def.kind !== 'list') return c.json(err('NOT_A_LIST', 'This content is a single block; edit it instead.'), 400);
  const body = itemBody.safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json(err('VALIDATION_ERROR', 'Check the fields.'), 422);
  const checked = validateItem(def, body.data.data ?? {});
  if (!checked.ok) return c.json(err('VALIDATION_ERROR', checked.errors[0] ?? 'Check the fields.', { errors: checked.errors }), 422);
  const customised = await isCustomised(c.env.DB, def.key);
  const existing = customised ? await countStored(c.env.DB, def.key) : def.defaults.length;
  if (existing >= (def.maxItems ?? 50)) return c.json(err('LIMIT_REACHED', `At most ${def.maxItems ?? 50} items are allowed here.`), 422);
  const item: NewItem = { id: id(), sortOrder: existing, enabled: body.data.enabled ?? true, data: checked.data };
  await addItem(c.env.DB, def.key, item, customised ? null : seedFor(def.key), c.get('staff').id, now());
  await audit(c, 'site_content.item_created', 'site_content', def.key, { itemId: item.id });
  return c.json({ data: { id: item.id } }, 201);
});

admin.put('/site-content/api/:collection/items/:itemId', requireRole('admin', 'super_admin', 'editor'), async (c) => {
  const def = getCollection(c.req.param('collection'));
  if (!def) return c.json(unknown(), 404);
  const itemId = c.req.param('itemId');
  if (itemId.startsWith(DEFAULT_ID_PREFIX)) return c.json(err('NOT_CUSTOMISED', 'Customise this content before editing it.'), 409);
  const body = itemBody.safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json(err('VALIDATION_ERROR', 'Check the fields.'), 422);
  let data: NewItem["data"] | undefined;
  if (body.data.data) {
    const checked = validateItem(def, body.data.data);
    if (!checked.ok) return c.json(err('VALIDATION_ERROR', checked.errors[0] ?? 'Check the fields.', { errors: checked.errors }), 422);
    data = checked.data;
  }
  const patch: { enabled?: boolean; data?: NewItem['data'] } = {};
  if (data) patch.data = data;
  if (body.data.enabled !== undefined) patch.enabled = body.data.enabled;
  if (!(await updateItem(c.env.DB, def.key, itemId, patch, c.get('staff').id, now())))
    return c.json(err('NOT_FOUND', 'Item not found.'), 404);
  await audit(c, 'site_content.item_updated', 'site_content', def.key, { itemId });
  return c.json({ data: { id: itemId } });
});

admin.delete('/site-content/api/:collection/items/:itemId', requireRole('admin', 'super_admin'), async (c) => {
  const def = getCollection(c.req.param('collection'));
  if (!def) return c.json(unknown(), 404);
  if (def.kind !== 'list') return c.json(err('NOT_A_LIST', 'A single block cannot be deleted; reset it instead.'), 400);
  const itemId = c.req.param('itemId');
  if (itemId.startsWith(DEFAULT_ID_PREFIX)) return c.json(err('NOT_CUSTOMISED', 'Customise this content before deleting from it.'), 409);
  if (!(await deleteItem(c.env.DB, def.key, itemId, c.get('staff').id, now()))) return c.json(err('NOT_FOUND', 'Item not found.'), 404);
  await audit(c, 'site_content.item_deleted', 'site_content', def.key, { itemId });
  return c.json({ data: { id: itemId, deleted: true } });
});

admin.post('/site-content/api/:collection/reorder', requireRole('admin', 'super_admin', 'editor'), async (c) => {
  const def = getCollection(c.req.param('collection'));
  if (!def) return c.json(unknown(), 404);
  const body = z.object({ ids: z.array(z.string().uuid()).min(1).max(100) }).safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json(err('VALIDATION_ERROR', 'Send the ordered item ids.'), 422);
  const current = (await listStored(c.env.DB, def.key)).map((i) => i.id);
  const sameSet = body.data.ids.length === current.length && new Set(body.data.ids).size === current.length && body.data.ids.every((x) => current.includes(x));
  if (!sameSet) return c.json(err('STALE_LIST', 'The list changed; reload and try again.'), 409);
  await reorderItems(c.env.DB, def.key, body.data.ids, c.get('staff').id, now());
  await audit(c, 'site_content.reordered', 'site_content', def.key);
  return c.json({ data: { collection: def.key } });
});

admin.put('/site-content/api/:collection/singleton', requireRole('admin', 'super_admin', 'editor'), async (c) => {
  const def = getCollection(c.req.param('collection'));
  if (!def) return c.json(unknown(), 404);
  if (def.kind !== 'singleton') return c.json(err('NOT_A_SINGLE_BLOCK', 'This content is a list.'), 400);
  const body = itemBody.safeParse(await c.req.json().catch(() => null));
  if (!body.success) return c.json(err('VALIDATION_ERROR', 'Check the fields.'), 422);
  const checked = validateItem(def, body.data.data ?? {});
  if (!checked.ok) return c.json(err('VALIDATION_ERROR', checked.errors[0] ?? 'Check the fields.', { errors: checked.errors }), 422);
  const staffId = c.get('staff').id;
  const existing = (await listStored(c.env.DB, def.key))[0];
  if (existing) await updateItem(c.env.DB, def.key, existing.id, { data: checked.data }, staffId, now());
  else await seedCollection(c.env.DB, def.key, [{ id: id(), sortOrder: 0, enabled: true, data: checked.data }], staffId, now());
  await audit(c, 'site_content.saved', 'site_content', def.key);
  return c.json({ data: { collection: def.key } });
});

/** Removes all customisation of one collection so the built-in content shows again. */
admin.delete('/site-content/api/:collection', requireRole('admin', 'super_admin'), async (c) => {
  const def = getCollection(c.req.param('collection'));
  if (!def) return c.json(unknown(), 404);
  await resetCollection(c.env.DB, def.key);
  await audit(c, 'site_content.reset', 'site_content', def.key);
  return c.json({ data: { collection: def.key, customised: false } });
});

export default admin;
