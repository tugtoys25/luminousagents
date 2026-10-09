import type { Context, MiddlewareHandler } from 'hono';
import type { Env } from '../env';

export interface StaffIdentity {
  id: string;
  email: string;
  displayName: string;
  role: string;
}
type AccessClaims = {
  aud?: string[];
  email?: string;
  exp?: number;
  iss?: string;
  sub?: string;
  iat?: number;
  nbf?: number;
};

const decodeBase64Url = (value: string): Uint8Array => {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(normalized + '='.repeat((4 - (normalized.length % 4)) % 4));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
};
const decodeJson = <T>(value: string): T =>
  JSON.parse(new TextDecoder().decode(decodeBase64Url(value))) as T;

async function verifyAccessJwt(
  token: string,
  teamDomain: string,
  audience: string,
): Promise<AccessClaims> {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('Malformed Access JWT');
  const header = decodeJson<{ alg?: string; kid?: string }>(parts[0]!);
  if (header.alg !== 'RS256' || !header.kid) throw new Error('Unsupported Access JWT');
  const issuer = `https://${teamDomain.replace(/^https?:\/\//, '').replace(/\/$/, '')}`;
  const jwksResponse = await fetch(`${issuer}/cdn-cgi/access/certs`, {
    headers: { accept: 'application/json' },
  });
  if (!jwksResponse.ok) throw new Error('Access signing keys unavailable');
  const jwks = (await jwksResponse.json()) as { keys?: JsonWebKey[] };
  const jwk = jwks.keys?.find((key) => (key as JsonWebKey & { kid?: string }).kid === header.kid);
  if (!jwk) throw new Error('Access signing key not found');
  const publicKey = await crypto.subtle.importKey(
    'jwk',
    jwk,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['verify'],
  );
  const valid = await crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5',
    publicKey,
    decodeBase64Url(parts[2]!),
    new TextEncoder().encode(`${parts[0]}.${parts[1]}`),
  );
  if (!valid) throw new Error('Invalid Access JWT signature');
  const claims = decodeJson<AccessClaims>(parts[1]!);
  const now = Math.floor(Date.now() / 1000);
  if (
    claims.iss !== issuer ||
    !claims.aud?.includes(audience) ||
    !claims.email ||
    !claims.sub ||
    !claims.exp ||
    claims.exp <= now ||
    (claims.nbf && claims.nbf > now) ||
    (claims.iat && claims.iat > now + 60)
  ) {
    throw new Error('Invalid Access JWT claims');
  }
  return claims;
}

export async function authenticateStaff(
  c: Context<{ Bindings: Env; Variables: { requestId: string; staff: StaffIdentity } }>,
): Promise<StaffIdentity | Response> {
  const teamDomain = c.env.ACCESS_TEAM_DOMAIN;
  const audience = c.env.ACCESS_AUD;
  if (!teamDomain || !audience)
    return c.json(
      {
        error: { code: 'AUTH_NOT_CONFIGURED', message: 'Staff access is not configured.' },
        requestId: c.get('requestId'),
      },
      503,
    );
  const token = c.req.header('Cf-Access-Jwt-Assertion');
  if (!token)
    return c.json(
      {
        error: { code: 'UNAUTHENTICATED', message: 'Staff sign-in required.' },
        requestId: c.get('requestId'),
      },
      401,
    );
  let claims: AccessClaims;
  try {
    claims = await verifyAccessJwt(token, teamDomain, audience);
  } catch {
    return c.json(
      {
        error: { code: 'UNAUTHENTICATED', message: 'Staff identity could not be verified.' },
        requestId: c.get('requestId'),
      },
      401,
    );
  }
  const user = await c.env.DB.prepare(
    "SELECT id, email, display_name AS displayName, role FROM users WHERE email = ? COLLATE NOCASE AND user_type = 'staff' AND status = 'active' LIMIT 1",
  )
    .bind(claims.email)
    .first<StaffIdentity>();
  if (!user)
    return c.json(
      {
        error: {
          code: 'FORBIDDEN',
          message: 'This identity is not provisioned as an active staff user.',
        },
        requestId: c.get('requestId'),
      },
      403,
    );
  return user;
}

export function staffAuth(): MiddlewareHandler<{
  Bindings: Env;
  Variables: { requestId: string; staff: StaffIdentity };
}> {
  return async (c, next) => {
    const identity = await authenticateStaff(c);
    if (identity instanceof Response) return identity;
    c.set('staff', identity);
    await next();
  };
}

export function requireRole(
  ...roles: string[]
): MiddlewareHandler<{ Bindings: Env; Variables: { requestId: string; staff: StaffIdentity } }> {
  return async (c, next) => {
    if (!roles.includes(c.get('staff').role))
      return c.json(
        {
          error: { code: 'FORBIDDEN', message: 'Your role cannot perform this action.' },
          requestId: c.get('requestId'),
        },
        403,
      );
    await next();
  };
}
