import { Hono } from 'hono';
import { loadContactForPages, type PublicApp } from './public-shared';
import homeRoutes from './public-home';
import listingsRoutes from './public-listings';
import detailRoutes from './public-detail';
import infoRoutes from './public-info';
import seoRoutes from './public-seo';

/** Public website pages, composed from focused modules. Contact settings load first for HTML requests. */
const publicPages = new Hono<PublicApp>();
publicPages.use('*', loadContactForPages);
publicPages.route('/', homeRoutes);
publicPages.route('/', listingsRoutes);
publicPages.route('/', detailRoutes);
publicPages.route('/', infoRoutes);
publicPages.route('/', seoRoutes);

export default publicPages;
