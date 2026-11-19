import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';
import type { Settings } from './config.js';

/** Cognito needs identity scope to include the owner-group claim. */
export function requiredScopes(settings: Pick<Settings, 'scope'>, additional: readonly string[] = []): string[] {
  return [...new Set(['openid', settings.scope, ...additional])];
}

/** The single resource-bound step-up scope shared by every vault write tool. */
export const writeScope = (settings: Pick<Settings, 'resource'>) => `${settings.resource}/write`;

export class AuthError extends Error {
  constructor(readonly status: 401 | 403) { super('Authentication required'); }
}
export function tokenVerifier(settings: Settings, key: JWTVerifyGetKey = createRemoteJWKSet(new URL(`${settings.issuer}/.well-known/jwks.json`), { timeoutDuration: 2000, cooldownDuration: 30000, cacheMaxAge: 600000 }), additionalScope?: string) {
  return async (authorization: string | null): Promise<string> => {
    const match = authorization?.match(/^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/iu);
    if (!match || match[1]!.length > 16384) throw new AuthError(401);
    try {
      const { payload } = await jwtVerify(match[1]!, key, {
        issuer: settings.issuer, audience: settings.resource, algorithms: ['RS256'],
        requiredClaims: ['exp', 'iat', 'sub', 'client_id', 'token_use', 'scope', 'aud'], clockTolerance: 5,
      });
      const grantedScopes = typeof payload.scope === 'string' ? payload.scope.split(' ') : [];
      if (typeof payload.iat !== 'number' || payload.iat > Date.now() / 1000 + 5 || payload.token_use !== 'access' || typeof payload.client_id !== 'string' || !settings.clientIds.includes(payload.client_id) || payload.aud !== settings.resource ||
        !requiredScopes(settings, additionalScope ? [additionalScope] : []).every(scope => grantedScopes.includes(scope)) ||
        typeof payload.sub !== 'string' || !payload.sub.length || payload.sub.length > 2048) throw new AuthError(401);
      const groups = payload['cognito:groups'];
      if (!Array.isArray(groups) || !groups.every(group => typeof group === 'string') || !groups.includes(settings.ownerGroup)) throw new AuthError(403);
      return payload.sub;
    } catch (error) { throw error instanceof AuthError ? error : new AuthError(401); }
  };
}
