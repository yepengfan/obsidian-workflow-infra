import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createHandler } from '../src/handler.js';
import { createVerifier } from '../src/auth.js';
import { config, MemoryStore } from './fixtures.js';

let endpoint: string;
let ownerToken: string;
let wrongScopeToken: string;
let wrongUserToken: string;
const store = new MemoryStore();
const logs: object[] = [];
const statuses: number[] = [];
let handler: ReturnType<typeof createHandler>;
const http = createServer(async (req, res) => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  const event = {
    version: '2.0', rawPath: new URL(req.url!, 'http://localhost').pathname,
    headers: req.headers, body: Buffer.concat(chunks).toString(), isBase64Encoded: false,
    requestContext: { http: { method: req.method }, requestId: 'test-request' },
  } as APIGatewayProxyEventV2;
  // Every invocation creates a fresh server and transport through the real Lambda adapter.
  const result = await handler(event);
  statuses.push(result.statusCode!);
  res.writeHead(result.statusCode!, result.headers as Record<string, string>);
  res.end(result.body);
});

beforeAll(async () => {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const jwk = { ...await exportJWK(publicKey), kid: 'owner-key', alg: 'RS256' };
  const sign = (claims: object) => new SignJWT({ scope: 'notes:read', azp: config.oauth.clientId, token_use: 'access', ...claims })
    .setProtectedHeader({ alg: 'RS256', kid: 'owner-key' }).setIssuer(config.oauth.issuer)
    .setAudience(config.resource).setSubject('owner').setExpirationTime('5m').sign(privateKey);
  ownerToken = await sign({});
  wrongScopeToken = await sign({ scope: 'other' });
  wrongUserToken = await new SignJWT({ scope: 'notes:read', azp: config.oauth.clientId, token_use: 'access' })
    .setProtectedHeader({ alg: 'RS256', kid: 'owner-key' }).setIssuer(config.oauth.issuer)
    .setAudience(config.resource).setSubject('stranger').setExpirationTime('5m').sign(privateKey);
  handler = createHandler(config, store, createVerifier(config, createLocalJWKSet({ keys: [jwk] })), (entry) => logs.push(entry));
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  endpoint = `http://127.0.0.1:${(http.address() as AddressInfo).port}/mcp`;
});
afterAll(async () => { await new Promise<void>((resolve, reject) => http.close((error) => error ? reject(error) : resolve())); });

describe('Streamable HTTP through Lambda event adapter', () => {
  it('denies anonymous initialize, discovery of tools and note reads before S3', async () => {
    const count = store.lists.length + store.reads.length;
    for (const method of ['initialize', 'tools/list', 'tools/call']) {
      const response = await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method }) });
      expect(response.status).toBe(401);
      expect(response.headers.get('www-authenticate')).toContain('/.well-known/oauth-protected-resource/mcp');
      expect(await response.text()).not.toContain('Private body');
    }
    expect(store.lists.length + store.reads.length).toBe(count);
  });
  it('publishes only OAuth discovery anonymously', async () => {
    const response = await fetch(endpoint.replace('/mcp', '/.well-known/oauth-protected-resource/mcp'));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ resource: config.resource, authorization_servers: [config.oauth.issuer] });
  });
  it('connects the official client, lists tools and calls all three across fresh invocations', async () => {
    const client = new Client({ name: 'compatibility-test', version: '1' });
    const transport = new StreamableHTTPClientTransport(new URL(endpoint), { requestInit: { headers: { Authorization: `Bearer ${ownerToken}` } } });
    try {
      await client.connect(transport);
      expect(transport.sessionId).toBeUndefined();
      const tools = await client.listTools();
      expect(tools.tools.map((t) => t.name).sort()).toEqual(['list_notes', 'read_note', 'search_notes']);
      expect(tools.tools.every((t) => t.annotations?.readOnlyHint)).toBe(true);
      const listed = await client.callTool({ name: 'list_notes', arguments: {} });
      expect(JSON.stringify(listed)).toContain('中文.md');
      const found = await client.callTool({ name: 'search_notes', arguments: { query: 'typescript' } });
      expect(JSON.stringify(found)).toContain('Private body');
      const read = await client.callTool({ name: 'read_note', arguments: { path: 'Projects/中文.md' } });
      expect(JSON.stringify(read)).toContain('中文笔记');
      const invalid = await client.callTool({ name: 'read_note', arguments: { path: '../secret.md' } });
      expect(invalid.isError).toBe(true);
      const repeated = await Promise.all(Array.from({ length: 4 }, () => client.listTools()));
      expect(repeated).toHaveLength(4);
    } finally { await client.close(); }
    expect(statuses).toContain(202); // initialized notification is accepted separately
    expect(JSON.stringify(logs)).not.toMatch(/Private body|中文|Bearer|owner-key|eyJ/u);
  });
  it('rejects wrong user and insufficient scopes', async () => {
    for (const [token, status] of [[wrongUserToken, 401], [wrongScopeToken, 403]] as const) {
      const response = await fetch(endpoint, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: '{}' });
      expect(response.status).toBe(status);
    }
  });
  it('finds every readable note when continuing after the per-call search budget', async () => {
    const previous = store.files;
    store.files = new Map(Array.from({ length: 30 }, (_, i) => [`vault/${String(i).padStart(2, '0')}.md`, 'needle in the body']));
    const client = new Client({ name: 'pagination-regression', version: '1' });
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(endpoint), {
        requestInit: { headers: { authorization: `Bearer ${ownerToken}` } },
      }));
      const paths = new Set<string>();
      let cursor: string | undefined;
      let pages = 0;
      do {
        const result = await client.callTool({ name: 'search_notes', arguments: { query: 'needle', ...(cursor ? { cursor } : {}) } });
        expect(result.isError).not.toBe(true);
        const content = result.content as { type: string; text: string }[];
        const page = JSON.parse(content[0]!.text) as { matches: { path: string }[]; next_cursor: string | null; body_read_budget_used_bytes: number };
        expect(page.body_read_budget_used_bytes).toBeLessThanOrEqual(512 * 1024);
        for (const match of page.matches) paths.add(match.path);
        cursor = page.next_cursor ?? undefined;
        pages++;
      } while (cursor && pages < 10);
      expect(cursor).toBeUndefined();
      expect(paths.size).toBe(30);
    } finally { await client.close(); store.files = previous; }
  });
  it('rejects hostile Origin, malformed JSON and oversized requests', async () => {
    const auth = { authorization: `Bearer ${ownerToken}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
    expect((await fetch(endpoint, { method: 'POST', headers: { ...auth, origin: 'https://attacker.example' }, body: '{}' })).status).toBe(403);
    expect((await fetch(endpoint, { method: 'POST', headers: auth, body: '{' })).status).toBe(400);
    expect((await fetch(endpoint, { method: 'POST', headers: auth, body: 'x'.repeat(17 * 1024) })).status).toBe(413);
    expect((await fetch(endpoint, { headers: auth })).status).toBe(405);
    expect((await fetch(endpoint, { method: 'DELETE', headers: auth })).status).toBe(405);
    const response = await fetch(endpoint, { method: 'OPTIONS', headers: { origin: 'https://chatgpt.com' } });
    expect(response.status).toBe(204);
    expect(response.headers.get('access-control-allow-origin')).toBe('https://chatgpt.com');
  });
  it('handles a base64-encoded API Gateway body and redacts downstream errors', async () => {
    const body = JSON.stringify({ jsonrpc: '2.0', id: 42, method: 'tools/call', params: { name: 'read_note', arguments: { path: 'missing.md' } } });
    const result = await handler({
      version: '2.0', routeKey: 'ANY /mcp', rawQueryString: '',
      rawPath: '/mcp', headers: { authorization: `Bearer ${ownerToken}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      isBase64Encoded: true, body: Buffer.from(body).toString('base64'), requestContext: { http: { method: 'POST' }, requestId: 'base64' },
    } as unknown as APIGatewayProxyEventV2);
    expect(result.statusCode).toBe(200); expect(result.body).toContain('isError');
    expect(result.body).not.toContain('private details');
  });
});
