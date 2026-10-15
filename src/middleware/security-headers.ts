import type { MiddlewareHandler } from 'hono';
import type { Env } from '../env';
import { SVG_SANDBOX_CSP } from '../security/svg-sanitizer';

const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
  "script-src 'self' https://challenges.cloudflare.com https://www.googletagmanager.com",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' https: data:",
  "font-src 'self'",
  "connect-src 'self' https://challenges.cloudflare.com https://www.google-analytics.com https://region1.google-analytics.com https://www.googletagmanager.com",
  'frame-src https://challenges.cloudflare.com',
  'upgrade-insecure-requests',
].join('; ');

// Buyer account page: same-origin framing is needed for the in-page document preview.
// object-src 'self' is required because Chromium applies the embedding page's object-src to the
// built-in PDF viewer when a PDF is shown inside an iframe.
const ACCOUNT_CONTENT_SECURITY_POLICY = CONTENT_SECURITY_POLICY.replace(
  'frame-src https://challenges.cloudflare.com',
  "frame-src 'self' https://challenges.cloudflare.com",
).replace("object-src 'none'", "object-src 'self'");
// Preview responses (PDF / image / plain text only) may be framed by the buyer account page, nothing else.
const PREVIEW_CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "img-src 'self' data:",
  "style-src 'unsafe-inline'",
  "object-src 'self'",
  "frame-ancestors 'self'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');
const PREVIEW_PATH = /^\/api\/buyer\/documents\/[^/]+\/preview$/;

export const securityHeadersMiddleware: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
  await next();
  const path = new URL(c.req.url).pathname;
  const isPreview = PREVIEW_PATH.test(path);
  // An SVG served directly (logos, favicons) gets a sandboxing policy: no script, no network.
  const isSvg = (c.res.headers.get('content-type') ?? '').toLowerCase().startsWith('image/svg+xml');
  c.header(
    'Content-Security-Policy',
    isSvg
      ? SVG_SANDBOX_CSP
      : isPreview
        ? PREVIEW_CONTENT_SECURITY_POLICY
        : path === '/account'
          ? ACCOUNT_CONTENT_SECURITY_POLICY
          : CONTENT_SECURITY_POLICY,
  );
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('X-Frame-Options', isPreview || path === '/account' ? 'SAMEORIGIN' : 'DENY');
  c.header('Referrer-Policy', 'strict-origin-when-cross-origin');
  c.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  c.header('Cross-Origin-Opener-Policy', 'same-origin');
  c.header('Cross-Origin-Resource-Policy', 'same-origin');
  c.header('X-Permitted-Cross-Domain-Policies', 'none');
  if (c.env.APP_ENV === 'production') {
    c.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
};
