import { createRemoteJWKSet, jwtVerify } from 'jose';
import { config } from '../config.js';

// Cache one JWKS resolver per unique JWKS URI (resource flow vs service flow).
const jwksByUri = new Map();
function getJwks(uri) {
  if (!jwksByUri.has(uri)) jwksByUri.set(uri, createRemoteJWKSet(new URL(uri)));
  return jwksByUri.get(uri);
}

/**
 * Validate the resource access token the way a protected resource server would:
 * verify the signature against the auth server's JWKS, check issuer + expiry,
 * then enforce that the required scopes are present.
 *
 * `opts.issuer` / `opts.jwksUri` override the defaults (the resource auth server),
 * letting each flow validate against its own authorization server.
 *
 * Returns a plain object describing the outcome (never throws).
 */
export async function validateAccessToken(token, requiredScopes = [], opts = {}) {
  const issuer = opts.issuer || config.resource.issuer;
  const jwksUri = opts.jwksUri || config.resource.jwksUri;
  const result = {
    verified: false,
    issuer: null,
    audience: null,
    scopes: [],
    requiredScopes,
    scopeOk: false,
    expiresAt: null,
    ok: false,
  };

  try {
    const { payload } = await jwtVerify(token, getJwks(jwksUri), { issuer });
    result.verified = true;
    result.issuer = payload.iss;
    result.audience = payload.aud;
    result.expiresAt = payload.exp ? new Date(payload.exp * 1000).toISOString() : null;

    const scp = Array.isArray(payload.scp)
      ? payload.scp
      : typeof payload.scope === 'string'
        ? payload.scope.split(' ')
        : [];
    result.scopes = scp;
    result.scopeOk = requiredScopes.every((s) => scp.includes(s));
  } catch (err) {
    result.error = err.code || err.message;
  }

  result.ok = result.verified && result.scopeOk;
  return result;
}
