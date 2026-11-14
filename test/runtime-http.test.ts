import { beforeAll, describe, expect, it } from 'vitest';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { tokenVerifier } from '../src/auth.js';
import { createFetchHandler } from '../src/handler.js';
import { runtimeOptionsSchema } from '../src/config.js';
import { MemoryStore, owner, runtimeSettings } from './runtime-fixtures.js';

let keys: Awaited<ReturnType<typeof generateKeyPair>>;
let jwks: ReturnType<typeof createLocalJWKSet>;
beforeAll(async () => { keys = await generateKeyPair('RS256', { extractable: true }); jwks = createLocalJWKSet({ keys: [{ ...await exportJWK(keys.publicKey), kid: 'test', alg: 'RS256' }] }); });
async function token(overrides: Record<string, unknown> = {}) {
  const settings = runtimeSettings(); const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ iss: settings.issuer, sub: owner, client_id: settings.clientId, token_use: 'access', aud: settings.resource,
    scope: settings.scope, iat: now, exp: now + 900, ...overrides }).setProtectedHeader({ alg: 'RS256', kid: 'test' }).sign(keys.privateKey);
}
describe('authenticated stateless Streamable HTTP', () => {
  it('publishes discovery and challenges anonymous MCP calls without touching S3', async () => {
    const settings = runtimeSettings(), store = new MemoryStore(); const fetch = createFetchHandler(settings, { store });
    const metadata = await fetch(new Request(new URL('/.well-known/oauth-protected-resource/mcp', settings.resource)));
    expect(metadata.status).toBe(200); expect(await metadata.json()).toMatchObject({ resource: settings.resource, authorization_servers: [settings.issuer] });
    const response = await fetch(new Request(settings.resource, { method: 'POST', body: '{}' }));
    expect(response.status).toBe(401); expect(response.headers.get('WWW-Authenticate')).toContain('resource_metadata=');
    expect(response.headers.get('Cache-Control')).toBe('no-store'); expect(store.calls).toHaveLength(0);
  });
  it.each([
    { aud: 'https://other.example/mcp' }, { aud: [runtimeSettings().resource] }, { client_id: 'other' }, { token_use: 'id' },
    { iss: 'https://other.example' }, { exp: 1 }, { scope: 'other/read' }, { iat: 4102444800 }, { nbf: 4102444800 },
  ])('rejects invalid token claims %j', async overrides => {
    const verify = tokenVerifier(runtimeSettings(), jwks);
    await expect(verify(`Bearer ${await token(overrides)}`)).rejects.toMatchObject({ status: 401 });
  });
  it('denies valid non-owner tokens and an empty allowlist', async () => {
    await expect(tokenVerifier(runtimeSettings(), jwks)(`Bearer ${await token({ sub: 'other-owner' })}`)).rejects.toMatchObject({ status: 403 });
    await expect(tokenVerifier(runtimeSettings({ ownerSubjects: [] }), jwks)(`Bearer ${await token()}`)).rejects.toMatchObject({ status: 403 });
  });
  it.each(['Opaque-Cognito-Owner', 'opaque-cognito-owner ', ' opaque-cognito-owner'])('denies a signed subject differing in case or whitespace: %s', async subject => {
    const settings = runtimeSettings(runtimeOptionsSchema.parse({ ownerSubjects: ['opaque-cognito-owner'] }));
    const verify = tokenVerifier(settings, jwks);
    await expect(verify(`Bearer ${await token({ sub: 'opaque-cognito-owner' })}`)).resolves.toBe('opaque-cognito-owner');
    await expect(verify(`Bearer ${await token({ sub: subject })}`)).rejects.toMatchObject({ status: 403 });
  });
  it('rejects bad signatures', async () => {
    const other = await generateKeyPair('RS256'); const now = Math.floor(Date.now() / 1000);
    const bad = await new SignJWT({ sub: owner, iat: now, exp: now + 900 }).setProtectedHeader({ alg: 'RS256', kid: 'test' }).sign(other.privateKey);
    await expect(tokenVerifier(runtimeSettings(), jwks)(`Bearer ${bad}`)).rejects.toMatchObject({ status: 401 });
  });
  it.each([owner, 'aaaaaaaa-bbbb-7ccc-dddd-eeeeeeeeeeee', 'opaque-cognito-subject'])('uses the real SDK client across fresh invocation instances for subject %s, with structured read-only tools and no sessions', async subject => {
    const settings = runtimeSettings(runtimeOptionsSchema.parse({ ownerSubjects: [subject] })), store = new MemoryStore(); const bearer = await token({ sub: subject }); const logs: unknown[] = []; const statuses: number[] = [];
    const client = new Client({ name: 'test-chatgpt-client', version: '1' });
    const transport = new StreamableHTTPClientTransport(new URL(settings.resource), {
      requestInit: { headers: { Authorization: `Bearer ${bearer}` } },
      fetch: async (input, init) => {
        const response = await createFetchHandler(settings, { store, verify: tokenVerifier(settings, jwks), log: event => logs.push(event) })(new Request(input, init));
        statuses.push(response.status); expect(response.headers.has('mcp-session-id')).toBe(false); return response;
      },
    });
    client.onerror = () => {};
    try {
      await client.connect(transport);
      const tools = await client.listTools();
      expect(tools.tools.map(tool => tool.name).sort()).toEqual(['list_notes', 'read_note', 'search_notes']);
      for (const tool of tools.tools) { expect(tool.annotations?.readOnlyHint).toBe(true); expect(tool._meta?.securitySchemes).toEqual([{ type: 'oauth2', scopes: [settings.scope] }]); expect(tool.outputSchema?.type).toBe('object'); }
      const list = await client.callTool({ name: 'list_notes', arguments: { folder: '' } });
      expect(list.structuredContent).toMatchObject({ notes: [{ path: 'hello.md' }], complete: false });
      const read = await client.callTool({ name: 'read_note', arguments: { path: 'hello.md' } });
      expect(read.structuredContent).toMatchObject({ text: 'Hello 私人知识库', complete: true });
      const search = await client.callTool({ name: 'search_notes', arguments: { mode: 'body', query: '私人', paths: ['hello.md'] } });
      expect(search.structuredContent).toMatchObject({ scope: 'selected_notes', complete: true, results: [{ path: 'hello.md', status: 'match' }] });
      const rejected = await client.callTool({ name: 'search_notes', arguments: { mode: 'body', query: 'secret', paths: [] } });
      expect(rejected.isError).toBe(true); expect(store.calls).toHaveLength(3);
      expect(JSON.stringify(logs)).not.toContain(bearer); expect(JSON.stringify(logs)).not.toContain('私人'); expect(JSON.stringify(logs)).not.toContain('hello.md');
      expect(statuses).toContain(202);
    } finally { await client.close(); }
  });
  it('rejects untrusted origins, returns 405 for authenticated streams and enforces request size', async () => {
    const settings = runtimeSettings(), store = new MemoryStore(); const fetch = createFetchHandler(settings, { store, verify: tokenVerifier(settings, jwks) });
    const authorization = `Bearer ${await token()}`;
    expect((await fetch(new Request(settings.resource, { method: 'POST', headers: { Authorization: authorization, Origin: 'https://evil.example' }, body: '{}' }))).status).toBe(403);
    for (const method of ['GET', 'DELETE']) expect((await fetch(new Request(settings.resource, { method, headers: { Authorization: authorization } }))).status).toBe(405);
    const large = await fetch(new Request(settings.resource, { method: 'POST', headers: { Authorization: authorization, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body: 'x'.repeat(65537) }));
    expect(large.status).toBe(413); expect(store.calls).toHaveLength(0);
  });
});
