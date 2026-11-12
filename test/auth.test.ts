import { beforeAll, describe, expect, it } from 'vitest';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { createVerifier } from '../src/auth.js';
import { config } from './fixtures.js';

let sign: (claims?: Record<string, unknown>, expiry?: number) => Promise<string>;
let verify: ReturnType<typeof createVerifier>;
beforeAll(async () => {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const jwk = { ...await exportJWK(publicKey), kid: 'test', alg: 'RS256' };
  verify = createVerifier(config, createLocalJWKSet({ keys: [jwk] }));
  sign = (claims = {}, expiry = Math.floor(Date.now() / 1000) + 600) => new SignJWT({
    iss: config.oauth.issuer, aud: config.resource, sub: 'owner', azp: config.oauth.clientId,
    scope: 'notes:read', token_use: 'access', exp: expiry, ...claims,
  }).setProtectedHeader({ alg: 'RS256', kid: 'test' }).sign(privateKey);
});

describe('OAuth resource authorization', () => {
  it('accepts an owner access token bound to this resource', async () => {
    await expect(verify(`Bearer ${await sign()}`)).resolves.toBeUndefined();
  });
  it('rejects every user when the owner allowlist is empty', async () => {
    const { publicKey, privateKey } = await generateKeyPair('RS256');
    const key = { ...await exportJWK(publicKey), kid: 'initial', alg: 'RS256' };
    const verifyEmpty = createVerifier({ ...config, oauth: { ...config.oauth, allowedSubjects: [] } }, createLocalJWKSet({ keys: [key] }));
    const token = await new SignJWT({ azp: config.oauth.clientId, scope: config.oauth.scope, token_use: 'access' })
      .setProtectedHeader({ alg: 'RS256', kid: 'initial' }).setIssuer(config.oauth.issuer).setAudience(config.resource)
      .setSubject('owner').setExpirationTime('5m').sign(privateKey);
    await expect(verifyEmpty(`Bearer ${token}`)).rejects.toMatchObject({ status: 401 });
  });
  it.each([
    { iss: 'https://attacker.example/' }, { aud: 'https://elsewhere.example/mcp' },
    { sub: 'another-user' }, { azp: 'another-client' }, { token_use: 'id' }, { token_use: undefined }, { exp: undefined },
  ])('rejects incorrect or missing claims %j', async (claims) => {
    await expect(verify(`Bearer ${await sign(claims)}`)).rejects.toMatchObject({ status: 401 });
  });
  it('rejects expired, tampered, missing and wrong-scope tokens', async () => {
    await expect(verify(`Bearer ${await sign({}, 1)}`)).rejects.toMatchObject({ status: 401 });
    const token = await sign(); const [header, payload, signature] = token.split('.');
    await expect(verify(`Bearer ${header}.${payload}.${signature?.slice(0, 5)}AAAA`)).rejects.toThrow();
    await expect(verify(null)).rejects.toMatchObject({ status: 401 });
    await expect(verify(`Bearer ${await sign({ scope: 'notes:write' })}`)).rejects.toMatchObject({ status: 403, code: 'insufficient_scope' });
  });
});
