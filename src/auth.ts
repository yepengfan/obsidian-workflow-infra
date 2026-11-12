import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';
import type { RuntimeConfig } from './config.js';

export class AuthFailure extends Error {
  constructor(public readonly status: 401 | 403, public readonly code: 'invalid_token' | 'insufficient_scope') {
    super(code);
  }
}

export function createVerifier(config: RuntimeConfig, key?: JWTVerifyGetKey) {
  const jwks = key ?? createRemoteJWKSet(new URL(config.oauth.jwksUri), {
    timeoutDuration: 2500, cooldownDuration: 30_000, cacheMaxAge: 600_000,
  });
  return async (authorization: string | null): Promise<void> => {
    const token = /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/u.exec(authorization ?? '')?.[1];
    if (!token || token.length > 16_384) throw new AuthFailure(401, 'invalid_token');
    let claims;
    try {
      ({ payload: claims } = await jwtVerify(token, jwks, {
        issuer: config.oauth.issuer, audience: config.resource,
        algorithms: ['RS256'], requiredClaims: ['iss', 'aud', 'sub', 'exp'], clockTolerance: 5,
      }));
    } catch {
      throw new AuthFailure(401, 'invalid_token');
    }
    if (claims.token_use !== 'access') throw new AuthFailure(401, 'invalid_token');
    if (!config.oauth.allowedSubjects.includes(claims.sub!) ||
        (claims.azp ?? claims.client_id) !== config.oauth.clientId) {
      throw new AuthFailure(401, 'invalid_token');
    }
    if (typeof claims.scope !== 'string' || !claims.scope.split(' ').includes(config.oauth.scope)) {
      throw new AuthFailure(403, 'insufficient_scope');
    }
  };
}
