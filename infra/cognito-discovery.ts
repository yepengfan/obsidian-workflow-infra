import { z } from 'zod';
import { createHash, randomBytes, randomUUID } from 'node:crypto';

const metadataSchema = z.object({
  issuer: z.string(), jwks_uri: z.string(),
  authorization_endpoint: z.string(), token_endpoint: z.string(),
  code_challenge_methods_supported: z.array(z.string()).refine(methods => methods.includes('S256')),
  response_types_supported: z.array(z.string()).refine(types => types.includes('code')),
  token_endpoint_auth_methods_supported: z.array(z.string())
    .refine(methods => methods.some(method => ['client_secret_basic', 'client_secret_post'].includes(method))),
});

/** Read public metadata only. No credentials, token exchange or registrations. */
export async function checkCognitoDiscovery(issuer: string, domain: string, fetcher: typeof fetch = fetch): Promise<void> {
  for (const value of [issuer, domain]) {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error('Invalid Cognito HTTPS URL');
  }
  const url = new URL(issuer);
  const candidates = [
    `${url.origin}/.well-known/oauth-authorization-server${url.pathname}`,
    `${issuer}/.well-known/openid-configuration`,
  ];
  for (const candidate of candidates) {
    try {
      const response = await fetcher(candidate, { signal: AbortSignal.timeout(5000), redirect: 'error', headers: { Accept: 'application/json' } });
      if (!response.ok || !response.body) { await response.body?.cancel(); continue; }
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          bytes += value.byteLength;
          if (bytes > 65_536) throw new Error('Oversized discovery document');
          chunks.push(value);
        }
      } finally { await reader.cancel(); }
      const metadata = metadataSchema.parse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      if (metadata.issuer !== issuer || metadata.jwks_uri !== `${issuer}/.well-known/jwks.json` ||
          metadata.authorization_endpoint !== `${domain}/oauth2/authorize` || metadata.token_endpoint !== `${domain}/oauth2/token`) continue;
      return;
    } catch { /* Bounded standards-based fallback; never print remote bodies. */ }
  }
  throw new Error('Cognito discovery failed: require matching issuer/JWKS/domain endpoints, authorization code, S256 and confidential-client authentication. OAuth and note access must remain disabled.');
}

/** Validate resource/scopes before login. Never follow the callback or exchange a code. */
export async function checkCognitoResourceBinding(domain: string, resource: string, scope: string, clientId: string, callback: string, fetcher: typeof fetch = fetch): Promise<void> {
  const state = randomUUID();
  const authorization = new URL(`${domain}/oauth2/authorize`);
  authorization.search = new URLSearchParams({
    response_type: 'code', client_id: clientId, redirect_uri: callback, resource,
    scope: `openid email phone profile ${scope}`, prompt: 'none', state,
    code_challenge_method: 'S256', code_challenge: createHash('sha256').update(randomBytes(32).toString('base64url')).digest('base64url'),
  }).toString();
  const response = await fetcher(authorization.href, { redirect: 'manual', credentials: 'omit', signal: AbortSignal.timeout(5000) });
  await response.body?.cancel();
  const location = response.headers.get('Location');
  if (![302, 303].includes(response.status) || !location) throw new Error('Cognito anonymous authorization check failed');
  let target: URL;
  try { target = new URL(location); } catch { throw new Error('Cognito returned an invalid authorization redirect'); }
  const expected = new URL(callback);
  if (target.origin !== expected.origin || target.pathname !== expected.pathname || target.hash || target.username || target.password ||
      target.searchParams.get('error') !== 'login_required' || target.searchParams.get('state') !== state ||
      ['code', 'access_token', 'id_token', 'refresh_token'].some(key => target.searchParams.has(key))) {
    throw new Error('Cognito rejected resource-bound authorization parameters or returned an unexpected grant');
  }
}
