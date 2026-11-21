import { beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { tokenVerifier } from '../src/auth.js';
import { runtimeOptionsSchema } from '../src/config.js';
import { createFetchHandler } from '../src/handler.js';
import { MemoryStore, owner, ownerGroup, runtimeSettings } from './runtime-fixtures.js';

let keys: Awaited<ReturnType<typeof generateKeyPair>>;
let jwks: ReturnType<typeof createLocalJWKSet>;
beforeAll(async () => { keys = await generateKeyPair('RS256', { extractable: true }); jwks = createLocalJWKSet({ keys: [{ ...await exportJWK(keys.publicKey), kid: 'test', alg: 'RS256' }] }); });
async function token(overrides: Record<string, unknown> = {}) {
  const settings = runtimeSettings(); const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ iss: settings.issuer, sub: owner, client_id: settings.clientIds[0], token_use: 'access', aud: settings.resource,
    scope: `openid ${settings.scope}`, 'cognito:groups': [ownerGroup], iat: now, exp: now + 900, ...overrides }).setProtectedHeader({ alg: 'RS256', kid: 'test' }).sign(keys.privateKey);
}
describe('authenticated stateless Streamable HTTP', () => {
  it.each(['test-client', 'claude-client'])('requests identity scope before rejecting owner membership for %s', async clientId => {
    const settings = runtimeSettings({ clientIds: ['test-client', 'claude-client'] }), store = new MemoryStore();
    const fetch = createFetchHandler(settings, { store, verify: tokenVerifier(settings, jwks) });
    const response = await fetch(new Request(settings.resource, { method: 'POST', headers: {
      Authorization: `Bearer ${await token({ client_id: clientId, scope: settings.scope, 'cognito:groups': undefined })}`,
    }, body: '{}' }));
    expect(response.status).toBe(401);
    expect(response.headers.get('WWW-Authenticate')).toContain(`scope="openid ${settings.scope}"`);
    expect(store.calls).toHaveLength(0);
    const metadata = await fetch(new Request(new URL('/.well-known/oauth-protected-resource/mcp', settings.resource)));
    expect((await metadata.json()).scopes_supported).toEqual(['openid', settings.scope]);
  });
  it('publishes discovery and challenges anonymous MCP calls without touching S3', async () => {
    const settings = runtimeSettings(), store = new MemoryStore(); const fetch = createFetchHandler(settings, { store });
    const metadata = await fetch(new Request(new URL('/.well-known/oauth-protected-resource/mcp', settings.resource)));
    expect(metadata.status).toBe(200); expect(await metadata.json()).toMatchObject({ resource: settings.resource, authorization_servers: [settings.issuer] });
    const response = await fetch(new Request(settings.resource, { method: 'POST', body: '{}' }));
    expect(response.status).toBe(401); expect(response.headers.get('WWW-Authenticate')).toContain('resource_metadata=');
    expect(response.headers.get('Cache-Control')).toBe('no-store'); expect(store.calls).toHaveLength(0);
  });
  it('challenges for every advertised scope when practice writes are enabled', async () => {
    const settings = runtimeSettings({ practice: { enabled: true, writesEnabled: true, timeZone: 'Australia/Brisbane' } });
    const fetch = createFetchHandler(settings, { store: new MemoryStore() });
    const metadata = await fetch(new Request(new URL('/.well-known/oauth-protected-resource/mcp', settings.resource)));
    const scopes = ['openid', settings.scope, `${settings.resource}/write`];
    expect((await metadata.json()).scopes_supported).toEqual(scopes);
    const response = await fetch(new Request(settings.resource, { method: 'POST', body: '{}' }));
    expect(response.status).toBe(401); expect(response.headers.get('WWW-Authenticate')).toContain(`scope="${scopes.join(' ')}"`);
  });
  it.each([
    { aud: 'https://other.example/mcp' }, { aud: [runtimeSettings().resource] }, { client_id: 'other' }, { token_use: 'id' },
    { iss: 'https://other.example' }, { exp: 1 }, { scope: 'openid' }, { scope: runtimeSettings().scope }, { scope: 'other/read' }, { scope: 'obsidian.notes/read' }, { iat: 4102444800 }, { nbf: 4102444800 },
  ])('rejects invalid token claims %j', async overrides => {
    const verify = tokenVerifier(runtimeSettings(), jwks);
    await expect(verify(`Bearer ${await token(overrides)}`)).rejects.toMatchObject({ status: 401 });
  });
  it.each([
    { label: 'missing', groups: undefined }, { label: 'null', groups: null }, { label: 'empty', groups: [] },
    { label: 'unrelated', groups: ['other-group'] }, { label: 'different case', groups: ['Obsidian-mcp-owners'] },
    { label: 'trailing space', groups: ['obsidian-mcp-owners '] }, { label: 'leading space', groups: [' obsidian-mcp-owners'] },
    { label: 'string', groups: ownerGroup }, { label: 'object', groups: { name: ownerGroup } }, { label: 'mixed types', groups: [ownerGroup, 1] },
  ])('denies a valid token without exact, well-formed group membership: $label', async ({ groups }) => {
    const settings = runtimeSettings(), store = new MemoryStore();
    const logs: unknown[] = [];
    const fetch = createFetchHandler(settings, { store, verify: tokenVerifier(settings, jwks), log: event => logs.push(event) });
    const response = await fetch(new Request(settings.resource, { method: 'POST', headers: { Authorization: `Bearer ${await token({ 'cognito:groups': groups })}` }, body: '{}' }));
    expect(response.status).toBe(403); expect(store.calls).toHaveLength(0);
    expect(logs).toEqual([expect.objectContaining({ status: 403, denialReason: 'owner_group' })]);
  });
  it('accepts group members independently of their opaque user subject', async () => {
    const verify = tokenVerifier(runtimeSettings(), jwks);
    await expect(verify(`Bearer ${await token({ sub: 'another-Cognito-user', 'cognito:groups': ['other-group', ownerGroup] })}`)).resolves.toBe('another-Cognito-user');
  });
  it.each([
    { label: 'null', subject: null }, { label: 'number', subject: 1 }, { label: 'array', subject: [] },
    { label: 'object', subject: {} }, { label: 'empty', subject: '' }, { label: 'oversized', subject: 'x'.repeat(2049) },
  ])('rejects an invalid subject even with owner group membership: $label', async ({ subject }) => {
    await expect(tokenVerifier(runtimeSettings(), jwks)(`Bearer ${await token({ sub: subject })}`)).rejects.toMatchObject({ status: 401 });
  });
  it('rejects bad signatures', async () => {
    const other = await generateKeyPair('RS256'); const now = Math.floor(Date.now() / 1000);
    const bad = await new SignJWT({ sub: owner, iat: now, exp: now + 900 }).setProtectedHeader({ alg: 'RS256', kid: 'test' }).sign(other.privateKey);
    await expect(tokenVerifier(runtimeSettings(), jwks)(`Bearer ${bad}`)).rejects.toMatchObject({ status: 401 });
  });
  it.each([
    { client_id: 'unregistered-client' }, { client_id: ['claude-client'] }, { client_id: null },
    { client_id: '' }, { client_id: 'claude-client ' },
    { aud: 'https://other.example/mcp' }, { token_use: 'id' }, { scope: 'openid email' },
    { iss: 'https://other.example' }, { exp: 1 },
    { 'cognito:groups': [] }, { 'cognito:groups': [ownerGroup, 1] },
  ])('rejects invalid credentials with both clients configured before S3 access: %j', async claims => {
    const settings = runtimeSettings({ clientIds: ['test-client', 'claude-client'] }), store = new MemoryStore();
    const logs: unknown[] = [];
    const fetch = createFetchHandler(settings, { store, verify: tokenVerifier(settings, jwks), log: event => logs.push(event) });
    const response = await fetch(new Request(settings.resource, { method: 'POST',
      headers: { Authorization: `Bearer ${await token({ client_id: 'claude-client', ...claims })}` }, body: '{}' }));
    expect(response.status).toBe('cognito:groups' in claims ? 403 : 401);
    expect(store.calls).toHaveLength(0);
    expect(logs).toEqual([expect.objectContaining({ denialReason: 'cognito:groups' in claims ? 'owner_group' : 'authentication' })]);
  });
  it.each([owner, 'aaaaaaaa-bbbb-7ccc-dddd-eeeeeeeeeeee', 'opaque-cognito-subject'].flatMap(subject =>
    ['test-client', 'claude-client'].map(clientId => ({ subject, clientId }))))('uses the real SDK client across fresh invocations for $clientId and subject $subject', async ({ subject, clientId }) => {
    const configuredOrigins = runtimeOptionsSchema.shape.allowedOrigins.parse(JSON.parse(fs.readFileSync('config/mcp-runtime.json', 'utf8')).allowedOrigins);
    const settings = runtimeSettings({ clientIds: ['test-client', 'claude-client'], allowedOrigins: configuredOrigins }), store = new MemoryStore();
    const bearer = await token({ sub: subject, client_id: clientId }); const logs: unknown[] = []; const statuses: number[] = [];
    const client = new Client({ name: 'test-chatgpt-client', version: '1' });
    const transport = new StreamableHTTPClientTransport(new URL(settings.resource), {
      requestInit: { headers: { Authorization: `Bearer ${bearer}`, Origin: clientId === 'claude-client' ? 'https://claude.ai' : 'https://chatgpt.com' } },
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
      for (const tool of tools.tools) { expect(tool.annotations?.readOnlyHint).toBe(true); expect(tool._meta?.securitySchemes).toEqual([{ type: 'oauth2', scopes: ['openid', settings.scope] }]); expect(tool.outputSchema?.type).toBe('object'); }
      const list = await client.callTool({ name: 'list_notes', arguments: { folder: '' } });
      expect(list.structuredContent).toMatchObject({ notes: [{ path: 'hello.md' }], complete: false });
      const read = await client.callTool({ name: 'read_note', arguments: { path: 'hello.md' } });
      expect(read.structuredContent).toMatchObject({ text: 'Hello 私人知识库', complete: true });
      const search = await client.callTool({ name: 'search_notes', arguments: { mode: 'body', query: '私人', paths: ['hello.md'] } });
      expect(search.structuredContent).toMatchObject({ scope: 'selected_notes', complete: true, results: [{ path: 'hello.md', status: 'match' }] });
      const rejected = await client.callTool({ name: 'search_notes', arguments: { mode: 'body', query: 'secret', paths: [] } });
      expect(rejected.isError).toBe(true); expect(store.calls).toHaveLength(3);
      expect(JSON.stringify(logs)).not.toContain(bearer); expect(JSON.stringify(logs)).not.toContain('私人'); expect(JSON.stringify(logs)).not.toContain('hello.md');
      expect(JSON.stringify(logs)).not.toContain('denialReason');
      expect(statuses).toContain(202);
    } finally { await client.close(); }
  });
  it('rejects untrusted origins, returns 405 for authenticated streams and enforces request size', async () => {
    const settings = runtimeSettings(), store = new MemoryStore(); const fetch = createFetchHandler(settings, { store, verify: tokenVerifier(settings, jwks) });
    const authorization = `Bearer ${await token()}`;
    expect((await fetch(new Request(settings.resource, { method: 'POST', headers: { Authorization: authorization, Origin: 'https://evil.example' }, body: '{}' }))).status).toBe(403);
    for (const method of ['GET', 'DELETE']) expect((await fetch(new Request(settings.resource, { method, headers: { Authorization: authorization } }))).status).toBe(405);
    const large = await fetch(new Request(settings.resource, { method: 'POST', headers: { Authorization: authorization, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body: 'x'.repeat(settings.limits.requestBytes + 1) }));
    expect(large.status).toBe(413); expect(store.calls).toHaveLength(0);
  });
  it.each([
    { Origin: 'https://claude.ai.evil.example' }, { Origin: 'null' }, { Host: 'untrusted.example' },
  ])('logs only a fixed reason when rejecting untrusted request headers: %j', async headers => {
    const configuredOrigins = runtimeOptionsSchema.shape.allowedOrigins.parse(JSON.parse(fs.readFileSync('config/mcp-runtime.json', 'utf8')).allowedOrigins);
    const settings = runtimeSettings({ allowedOrigins: configuredOrigins }), store = new MemoryStore();
    const logs: unknown[] = [];
    const bearer = await token();
    const fetch = createFetchHandler(settings, { store, verify: tokenVerifier(settings, jwks), log: event => logs.push(event) });
    const requestHeaders = new Headers({ Authorization: `Bearer ${bearer}` });
    for (const [name, value] of Object.entries(headers)) if (value !== undefined) requestHeaders.set(name, value);
    const response = await fetch(new Request(settings.resource, { method: 'POST', headers: requestHeaders, body: '{}' }), 'fixed-diagnostic-id');
    expect(response.status).toBe(403);
    expect(store.calls).toHaveLength(0);
    expect(logs).toEqual([{ event: 'mcp_request', requestId: 'fixed-diagnostic-id', status: 403, durationMs: expect.any(Number), denialReason: 'origin_or_host' }]);
    expect(JSON.stringify(logs)).not.toContain(bearer);
  });
});

it.each(['test-client', 'claude-client'])('requires read, write and owner membership for approved client %s', async clientId => {
  const settings = runtimeSettings({ clientIds: ['test-client', 'claude-client'] });
  const signed = (claims: Record<string, unknown> = {}) => token({ client_id: clientId, ...claims });
  const verifyWrite = tokenVerifier(settings, jwks, `${settings.resource}/write`);
  await expect(verifyWrite(`Bearer ${await signed()}`)).rejects.toMatchObject({ status: 401 });
  await expect(verifyWrite(`Bearer ${await signed({ scope: `openid ${settings.scope} ${settings.resource}/write` })}`)).resolves.toBe(owner);
  await expect(verifyWrite(`Bearer ${await signed({ scope: `openid ${settings.resource}/write` })}`)).rejects.toMatchObject({ status: 401 });
  await expect(verifyWrite(`Bearer ${await signed({ scope: `openid ${settings.scope} ${settings.resource}/write`, 'cognito:groups': [] })}`)).rejects.toMatchObject({ status: 403 });
});

it.each([false, true])('injects skill tools, instructions and scopes only when supplied: %s', async injected => {
  const settings = runtimeSettings({ practice: { enabled: true, writesEnabled: true, timeZone: 'Australia/Brisbane' } });
  const store = new MemoryStore(), scope = `${settings.resource}/fixture`;
  const contexts: { owner: string; signal: AbortSignal }[] = [], verifiedScopes: string[] = [];
  let scopedOwner = 'another-owner';
  const fetch = createFetchHandler(settings, { store, verify: async () => owner,
    verifyScope: async (_authorization, requestedScope) => { verifiedScopes.push(requestedScope); return scopedOwner; },
    skills: injected ? [{ instructions: 'Fixture skill instructions.', scopes: [scope], register: context => {
      contexts.push({ owner: context.owner, signal: context.signal });
      context.server.registerTool('fixture_skill', { inputSchema: {} }, () => context.result(async () => {
        await context.authorizeScope(scope);
        return { owner: context.owner, aborted: context.signal.aborted };
      }));
    } }] : [],
  });
  const discovery = await fetch(new Request(new URL('/.well-known/oauth-protected-resource/mcp', settings.resource)));
  expect((await discovery.json()).scopes_supported).toEqual(['openid', settings.scope, ...(injected ? [scope] : [])]);
  expect(contexts).toHaveLength(0);
  const client = new Client({ name: 'injected-skill-test', version: '1' });
  client.onerror = () => {};
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(settings.resource), {
      fetch: (input, init) => fetch(new Request(input, init)),
    }));
    expect(client.getInstructions()?.includes('Fixture skill instructions.')).toBe(injected);
    const tools = (await client.listTools()).tools.map(tool => tool.name).sort();
    expect(tools).toEqual(['list_notes', 'read_note', 'search_notes', ...(injected ? ['fixture_skill'] : [])].sort());
    if (injected) {
      expect((await client.callTool({ name: 'fixture_skill', arguments: {} })).isError).toBe(true);
      scopedOwner = owner;
      expect((await client.callTool({ name: 'fixture_skill', arguments: {} })).structuredContent).toEqual({ owner, aborted: false });
      expect(verifiedScopes).toEqual([scope, scope]);
      expect(contexts.every(context => context.owner === owner && !context.signal.aborted)).toBe(true);
    }
    expect(store.calls).toHaveLength(0);
  } finally { await client.close(); }
});
