import { Hono } from 'hono';
import type { BuyerApp } from './shared';
import profileRoutes from './profile-routes';
import documentsRoutes from './documents-routes';
import ndaRoutes from './nda-routes';

/** Buyer account API, composed from focused modules (profile/saves, documents, NDA). */
const buyers = new Hono<BuyerApp>();
buyers.route('/', profileRoutes);
buyers.route('/', documentsRoutes);
buyers.route('/', ndaRoutes);

export default buyers;
