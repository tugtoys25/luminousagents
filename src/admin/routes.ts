import { Hono } from 'hono';
import { staffAuth } from '../auth/staff-session';
import type { AdminApp } from './shared';
import mediaRoutes from './routes/media';
import overviewRoutes from './routes/overview';
import opportunityQueueRoutes from './routes/opportunity-queue';
import opportunitiesRoutes from './routes/opportunities';
import opportunityLifecycleRoutes from './routes/opportunity-lifecycle';
import enquiriesRoutes from './routes/enquiries';
import buyersRoutes from './routes/buyers';
import ndaRoutes from './routes/nda';
import opportunityDocumentsRoutes from './routes/opportunity-documents';
import opportunityMediaRoutes from './routes/opportunity-media';
import documentsRoutes from './routes/documents';
import tasksRoutes from './routes/tasks';
import notificationsRoutes from './routes/notifications';
import accessGrantsRoutes from './routes/access-grants';
import auditRoutes from './routes/audit';
import settingsUiRoutes from './routes/settings-ui';
import settingsRoutes from './routes/settings';
import pagesRoutes from './routes/pages';
import formsRoutes from './routes/forms';
import sessionsRoutes from './routes/sessions';
import staffRoutes from './routes/staff';

/**
 * Staff dashboard router. Authentication is applied once here; every domain router below is
 * mounted after it, so each route is protected by staffAuth() and its own requireRole(...) check.
 * Mount order preserves the original registration order (see docs/ARCHITECTURE.md).
 */
const admin = new Hono<AdminApp>();
admin.use('*', staffAuth());

admin.route('/', mediaRoutes);
admin.route('/', overviewRoutes);
admin.route('/', opportunityQueueRoutes);
admin.route('/', opportunitiesRoutes);
admin.route('/', opportunityLifecycleRoutes);
admin.route('/', enquiriesRoutes);
admin.route('/', buyersRoutes);
admin.route('/', ndaRoutes);
admin.route('/', opportunityDocumentsRoutes);
admin.route('/', opportunityMediaRoutes);
admin.route('/', documentsRoutes);
admin.route('/', tasksRoutes);
admin.route('/', notificationsRoutes);
admin.route('/', accessGrantsRoutes);
admin.route('/', auditRoutes);
admin.route('/', settingsUiRoutes);
admin.route('/', settingsRoutes);
admin.route('/', pagesRoutes);
admin.route('/', formsRoutes);
admin.route('/', sessionsRoutes);
admin.route('/', staffRoutes);

export default admin;
