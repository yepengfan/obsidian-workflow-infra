import fs from 'node:fs';
import { httpsUrl } from '../src/config.js';

// Read-only deployment prerequisite check. Never requests or prints tokens.
const outputs = process.env.OAUTH_ISSUER ? undefined : JSON.parse(fs.readFileSync(process.env.CDK_OUTPUTS_FILE ?? 'cdk-outputs.json', 'utf8')) as Record<string, Record<string, string>>;
const expectedIssuer = httpsUrl.parse(process.env.OAUTH_ISSUER ?? outputs?.ObsidianS3Mcp?.OAuthIssuer);
const expectedJwks = `${expectedIssuer}/.well-known/jwks.json`;
const issuer = expectedIssuer.replace(/\/$/u, '');
const u = new URL(issuer);
const urls = [
  `${u.origin}/.well-known/oauth-authorization-server${u.pathname === '/' ? '' : u.pathname}`,
  `${issuer}/.well-known/openid-configuration`,
];
let valid = false;
for (const url of urls) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(5000), redirect: 'error' });
    if (!response.ok) continue;
    const metadata = await response.json() as Record<string, unknown>;
    const pkce = metadata.code_challenge_methods_supported;
    const methods = metadata.token_endpoint_auth_methods_supported;
    if (metadata.issuer !== expectedIssuer || !Array.isArray(pkce) || !pkce.includes('S256') ||
      !Array.isArray(methods) || !methods.some((m) => ['client_secret_post', 'client_secret_basic'].includes(String(m)))) continue;
    for (const field of ['authorization_endpoint', 'token_endpoint', 'jwks_uri']) {
      if (typeof metadata[field] !== 'string' || new URL(metadata[field]).protocol !== 'https:') throw new Error('Invalid endpoint');
    }
    if (metadata.jwks_uri !== expectedJwks) throw new Error('JWKS URI differs from configured value');
    valid = true;
    break;
  } catch { /* Try the next standards-based discovery URL. */ }
}
if (!valid) throw new Error('OAuth discovery failed: require matching issuer/JWKS, HTTPS endpoints, S256 and supported token auth. Do not deploy until resolved.');
console.log('OAuth discovery passed. Still verify resource binding, PKCE exchange and refresh with ChatGPT after approved deployment.');
