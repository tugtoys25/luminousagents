import { Hono } from 'hono';
import type { App } from './portal-shared';
import pagesRoutes from './portal-pages';
import authApiRoutes from './portal-auth-api';
import buyerCodeRoutes from './portal-buyer-code';
import onboardingRoutes from './portal-onboarding';

/** Sign-in portal: HTML pages plus staff/buyer auth APIs, composed from focused modules. */
const portal = new Hono<App>();
portal.route('/', pagesRoutes);
portal.route('/', authApiRoutes);
portal.route('/', buyerCodeRoutes);
portal.route('/', onboardingRoutes);

export default portal;
