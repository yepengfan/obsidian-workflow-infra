import { describe, expect, it, vi } from 'vitest';
import { checkCognitoDiscovery } from '../infra/cognito-discovery.js';

const issuer = 'https://cognito-idp.ap-southeast-2.amazonaws.com/ap-southeast-2_Example';
const domain = 'https://example.auth.ap-southeast-2.amazoncognito.com';
const metadata = {
  issuer, jwks_uri: `${issuer}/.well-known/jwks.json`,
  authorization_endpoint: `${domain}/oauth2/authorize`, token_endpoint: `${domain}/oauth2/token`,
  code_challenge_methods_supported: ['S256'], response_types_supported: ['code'],
  token_endpoint_auth_methods_supported: ['client_secret_basic'],
};

describe('live Cognito discovery contract', () => {
  it('accepts real advertised capabilities through the standard OIDC fallback', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response('', { status: 404 }))
      .mockResolvedValueOnce(Response.json(metadata));
    await expect(checkCognitoDiscovery(issuer, domain, fetcher)).resolves.toBeUndefined();
    expect(fetcher.mock.calls.map(call => call[0])).toEqual([
      'https://cognito-idp.ap-southeast-2.amazonaws.com/.well-known/oauth-authorization-server/ap-southeast-2_Example',
      `${issuer}/.well-known/openid-configuration`,
    ]);
    expect(fetcher.mock.calls.every(call => call[1]?.redirect === 'error' && call[1]?.signal instanceof AbortSignal)).toBe(true);
  });

  it.each([
    { name: 'missing PKCE declaration', patch: { code_challenge_methods_supported: undefined } },
    { name: 'plain-only PKCE', patch: { code_challenge_methods_supported: ['plain'] } },
    { name: 'issuer mismatch', patch: { issuer: 'https://other.example' } },
    { name: 'foreign JWKS', patch: { jwks_uri: 'https://other.example/keys' } },
    { name: 'HTTP authorization', patch: { authorization_endpoint: domain.replace('https:', 'http:') + '/oauth2/authorize' } },
    { name: 'foreign token endpoint', patch: { token_endpoint: 'https://other.example/token' } },
    { name: 'credentials embedded in URL', patch: { token_endpoint: 'https://secret@example.com/token' } },
    { name: 'implicit-only response', patch: { response_types_supported: ['token'] } },
    { name: 'unsupported client auth', patch: { token_endpoint_auth_methods_supported: ['none'] } },
  ])('fails closed for $name', async ({ patch }) => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => Response.json({ ...metadata, ...patch }));
    await expect(checkCognitoDiscovery(issuer, domain, fetcher)).rejects.toThrow('OAuth and note access must remain disabled');
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it.each(['oversized', 'malformed', 'redirect', 'timeout'] as const)('bounds and redacts a %s response', async kind => {
    const secret = 'unexpected-remote-secret';
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => {
      if (kind === 'timeout') throw new Error(secret);
      if (kind === 'redirect') return new Response(secret, { status: 302 });
      return new Response(kind === 'oversized' ? JSON.stringify({ ...metadata, padding: secret.repeat(4000) }) : secret);
    });
    try {
      await checkCognitoDiscovery(issuer, domain, fetcher);
      expect.fail('Invalid discovery accepted');
    } catch (error) {
      expect(String(error)).toContain('Cognito discovery failed');
      expect(String(error)).not.toContain(secret);
    }
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('rejects unsafe input before requesting metadata', async () => {
    const fetcher = vi.fn<typeof fetch>();
    await expect(checkCognitoDiscovery('http://example.com/pool', domain, fetcher)).rejects.toThrow('Invalid Cognito HTTPS URL');
    expect(fetcher).not.toHaveBeenCalled();
  });
});
